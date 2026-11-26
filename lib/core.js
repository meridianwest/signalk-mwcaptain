/*
  Core of the MW Captain Plugin: everything that does not depend on the autopilot brand.

  The app sends an authenticated PUT (Signal K token with write permission) to
      /signalk/v1/api/vessels/self/steering/autopilot/mwcaptain/command
  with {"value": "standby" | "auto" | "-1" | "+1" | "-10" | "+10"}.
  The core parses the command, applies the safety rules and asks the selected driver
  (drivers/*.js) only to read the autopilot state and to build the NMEA 2000 messages.
  The core formats and sends the messages itself: a driver never sends anything on the bus
  and cannot bypass the rules below.

  Safety (same as the MW Box), for every driver:
    - STANDBY always accepted (even if the autopilot has been silent for a moment), sent to the last known address
    - AUTO and course changes only if the autopilot was seen on the bus in the last 5 s
    - course changes only with the autopilot in AUTO, at most one every 0.4 s and 20° every 2 s
  Every 5 s the plugin publishes steering.autopilot.mwcaptain.status = "ready": the app sees it
  in the data stream and enables the autopilot controls; without it, it stays read-only.
*/

const KEY_DELTAS = { '-1': -1, '+1': 1, '-10': -10, '+10': 10 }
const KEY_MIN_INTERVAL_MS = 400
const KEY_WINDOW_MS = 2000
const KEY_WINDOW_MAX_DEG = 20
const PILOT_TIMEOUT_MS = 5000
const PUT_PATH = 'steering.autopilot.mwcaptain.command'
// Signal for the app: the plugin is installed and enabled (without it the app uses Signal K read-only)
const STATUS_PATH = 'steering.autopilot.mwcaptain.status'
const STATUS_EVERY_MS = 5000
const DRIVER_METHODS = ['state', 'modeMessage', 'keyMessage']

const hex = (b) => b.toString(16).padStart(2, '0')
const isByte = (b) => Number.isInteger(b) && b >= 0 && b <= 255

/** Checks that a driver module has the documented shape; returns '' or the problem. */
function checkDriver (d) {
  if (!d || typeof d !== 'object') return 'not an object'
  if (typeof d.id !== 'string' || !d.id) return 'missing id'
  if (typeof d.name !== 'string' || !d.name) return 'missing name'
  if (typeof d.create !== 'function') return 'missing create()'
  return ''
}

/** Checks a message built by a driver: { prio 0-7, pgn, dst 0-255, bytes [0-255, …] }. */
function checkFrame (f) {
  return !!f && typeof f === 'object' &&
    Number.isInteger(f.prio) && f.prio >= 0 && f.prio <= 7 &&
    Number.isInteger(f.pgn) && f.pgn > 0 && f.pgn <= 0x1ffff &&
    isByte(f.dst) &&
    Array.isArray(f.bytes) && f.bytes.length > 0 && f.bytes.length <= 223 && f.bytes.every(isByte)
}

/**
 * @param {object} app      the Signal K server app object
 * @param {Array}  drivers  driver modules (drivers/index.js); the first one is the default
 */
module.exports = function createPlugin (app, drivers) {
  for (const d of drivers) {
    const problem = checkDriver(d)
    if (problem) throw new Error('Invalid autopilot driver ' + (d && d.id) + ': ' + problem)
  }
  const byId = Object.fromEntries(drivers.map((d) => [d.id, d]))

  const plugin = {
    id: 'signalk-mwcaptain',
    name: 'MW Captain Plugin',
    description: 'MW Captain Plugin: autopilot commands from the MW Captain app (AUTO, STANDBY, ±1°, ±10°)'
  }

  let options = {}
  let driver = null // instance created by the selected driver module
  let statusTimer = null
  let lastKeyAt = 0
  let keyWindowStart = 0
  let keyWindowDeg = 0

  plugin.schema = {
    type: 'object',
    properties: {
      driver: {
        type: 'string',
        title: 'Autopilot',
        enum: drivers.map((d) => d.id),
        enumNames: drivers.map((d) => d.name),
        default: drivers[0].id
      },
      pilotAddress: {
        type: 'number',
        title: 'Autopilot NMEA 2000 address (used only if Signal K cannot detect it from the autopilot messages)',
        default: 204
      },
      sourceAddress: {
        type: 'number',
        title: 'Server address on the bus (0 = the gateway\'s own address)',
        default: 0
      }
    }
  }

  /** Message in the Actisense text format that canboatjs accepts on 'nmea2000out'. */
  function format (f) {
    const src = options.sourceAddress || 0
    return `${new Date().toISOString()},${f.prio},${f.pgn},${src},${f.dst},${f.bytes.length},${f.bytes.map(hex).join(',')}`
  }

  /** Driver output (one message or an array) → formatted strings; throws if anything is malformed. */
  function build (out) {
    const frames = Array.isArray(out) ? out : [out]
    if (!frames.length || !frames.every(checkFrame)) throw new Error('invalid message')
    return frames.map(format)
  }

  function send (msgs) {
    for (const msg of msgs) {
      app.emit('nmea2000out', msg)
      app.debug('sent: ' + msg)
    }
  }

  /** Autopilot state from the driver, plus the 5 s presence check done here, in the core. */
  function pilotInfo () {
    const s = driver.state() || {}
    const seenAt = Number(s.seenAt) || 0
    return {
      mode: s.mode,
      address: s.address,
      present: s.mode !== undefined && Date.now() - seenAt < PILOT_TIMEOUT_MS
    }
  }

  /** Runs a command; returns '' on success, otherwise the error message. */
  function command (raw) {
    const cmd = String(raw || '').trim().toLowerCase()
    try {
      const pilot = pilotInfo()

      if (cmd === 'standby') {
        // STANDBY has priority: always sent to the last known address
        send(build(driver.modeMessage('standby', pilot)))
        return ''
      }
      if (!pilot.present) return 'Autopilot not found on the NMEA 2000 bus'
      if (cmd === 'auto') {
        send(build(driver.modeMessage('auto', pilot)))
        return ''
      }
      if (KEY_DELTAS[cmd] !== undefined) {
        if (pilot.mode !== 'auto') return 'The autopilot is not in AUTO'
        const now = Date.now()
        if (lastKeyAt && now - lastKeyAt < KEY_MIN_INTERVAL_MS) return 'Too fast: one key at a time'
        if (!keyWindowStart || now - keyWindowStart >= KEY_WINDOW_MS) {
          keyWindowStart = now
          keyWindowDeg = 0
        }
        const deg = Math.abs(KEY_DELTAS[cmd])
        if (keyWindowDeg + deg > KEY_WINDOW_MAX_DEG) return 'Maximum 20° every 2 seconds: wait a moment'
        const msgs = build(driver.keyMessage(KEY_DELTAS[cmd], pilot))
        lastKeyAt = now
        keyWindowDeg += deg
        send(msgs)
        return ''
      }
    } catch (e) {
      return 'Autopilot driver error: ' + (e && e.message ? e.message : e)
    }
    return 'Unknown autopilot command: ' + cmd
  }

  plugin.start = function (opts) {
    options = opts || {}
    // Settings saved before drivers existed have no "driver": they keep the default (Raymarine)
    const mod = byId[options.driver || drivers[0].id]
    if (!mod) {
      app.setPluginError('Unknown autopilot driver: ' + options.driver)
      return
    }
    const ctx = {
      getSelfPath: (p) => app.getSelfPath(p),
      debug: (m) => app.debug(m),
      options: Object.freeze({ ...options })
    }
    driver = mod.create(ctx)
    for (const m of DRIVER_METHODS) {
      if (!driver || typeof driver[m] !== 'function') {
        driver = null
        app.setPluginError('Invalid autopilot driver ' + mod.id + ': missing ' + m + '()')
        return
      }
    }
    lastKeyAt = 0
    keyWindowStart = 0
    keyWindowDeg = 0

    // The server checks the token: a PUT only gets here with write permission
    app.registerPutHandler('vessels.self', PUT_PATH, (context, path, value, callback) => {
      const error = command(value)
      if (error) {
        app.setPluginError(error)
        return { state: 'COMPLETED', statusCode: 400, message: error }
      }
      app.setPluginStatus('Last command: ' + value)
      return { state: 'COMPLETED', statusCode: 200 }
    }, plugin.id)
    app.setPluginStatus('Ready (' + mod.name + '): waiting for commands from MW Captain')
    const announce = () => app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: STATUS_PATH, value: 'ready' }] }]
    })
    announce()
    statusTimer = setInterval(announce, STATUS_EVERY_MS)
  }

  plugin.stop = function () {
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = null
  }

  // For the tests
  plugin._internals = { command, format }

  return plugin
}
