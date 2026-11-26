/*
  signalk-mwcaptain — Raymarine autopilot control from the MW Captain app via Signal K.

  The app sends an authenticated PUT (Signal K token with write permission) to
      /signalk/v1/api/vessels/self/steering/autopilot/mwcaptain/command
  with {"value": "standby" | "auto" | "-1" | "+1" | "-10" | "+10"}.
  The plugin turns them into the same NMEA 2000 messages sent by the MW Box (firmware
  Autopilot.cpp):
    - mode (AUTO/STANDBY): PGN 126208, Command Group Function on PGN 65379 (Raymarine)
    - ±1° / ±10° course changes: PGN 126720, p70 control head keys
  Safety (same as the MW Box):
    - STANDBY always accepted (even if the autopilot has been silent for a moment), sent to the last known address
    - AUTO and course changes only if the autopilot was seen on the bus in the last 5 s
    - course changes only with the autopilot in AUTO, at most one every 0.4 s and 20° every 2 s
  Every 5 s the plugin publishes steering.autopilot.mwcaptain.status = "ready": the app sees it
  in the data stream and enables the autopilot controls; without it, it stays read-only.
  The autopilot state is read by Signal K itself (steering.autopilot.state and
  steering.autopilot.target.headingMagnetic, from Raymarine PGNs 65379 and 65360).
*/

const RAYMARINE = 1851
const KEY_CODES = { '-1': 0x05, '-10': 0x06, '+1': 0x07, '+10': 0x08 }
const MODES = { standby: 0x0000, auto: 0x0040 }
const KEY_MIN_INTERVAL_MS = 400
const KEY_WINDOW_MS = 2000
const KEY_WINDOW_MAX_DEG = 20
const PILOT_TIMEOUT_MS = 5000
const PUT_PATH = 'steering.autopilot.mwcaptain.command'
// Signal for the app: the plugin is installed and enabled (without it the app uses Signal K read-only)
const STATUS_PATH = 'steering.autopilot.mwcaptain.status'
const STATUS_EVERY_MS = 5000

module.exports = function (app) {
  const plugin = {
    id: 'signalk-mwcaptain',
    name: 'MW Captain Plugin',
    description: 'MW Captain Plugin: Raymarine autopilot commands from the MW Captain app (AUTO, STANDBY, ±1°, ±10°)'
  }

  let options = {}
  let statusTimer = null
  let lastKeyAt = 0
  let keyWindowStart = 0
  let keyWindowDeg = 0

  plugin.schema = {
    type: 'object',
    properties: {
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

  const hex = (b) => b.toString(16).padStart(2, '0')

  /** Message in the Actisense text format that canboatjs accepts on 'nmea2000out'. */
  function n2kString (prio, pgn, dst, bytes) {
    const src = options.sourceAddress || 0
    return `${new Date().toISOString()},${prio},${pgn},${src},${dst},${bytes.length},${bytes.map(hex).join(',')}`
  }

  function u16 (v) { return [v & 0xff, (v >> 8) & 0xff] }

  function modeMessage (dst, mode) {
    const bytes = [
      0x01, // Command
      0x63, 0xff, 0x00, // commanded PGN: 65379
      0xf8, // priority unchanged
      0x04, // 4 parameters
      0x01, ...u16(RAYMARINE), // 1: manufacturer
      0x03, 0x04, // 3: marine industry
      0x04, ...u16(mode), // 4: mode
      0x05, 0xff, 0xff // 5: sub-mode
    ]
    return n2kString(3, 126208, dst, bytes)
  }

  function keyMessage (dst, code) {
    const head = [0x3b, 0x9f, 0xf0, 0x81, 0x86, 0x21]
    const tail = [0xff, 0xff, 0xff, 0xff, 0xff, 0xc1, 0xc2, 0xcd, 0x66, 0x80, 0xd3, 0x42, 0xb1, 0xc8]
    return n2kString(7, 126720, dst, [...head, code, 0xff - code, ...tail])
  }

  /** Autopilot state and address, from the Signal K value steering.autopilot.state. */
  function pilotInfo () {
    const st = app.getSelfPath('steering.autopilot.state')
    const value = st && st.value !== undefined ? st.value : undefined
    const at = st && st.timestamp ? Date.parse(st.timestamp) : 0
    let address = options.pilotAddress || 204
    const source = st && (st.$source || '')
    const m = /\.(\d+)$/.exec(source || '')
    if (m) address = Number(m[1])
    return { state: value, present: value !== undefined && Date.now() - at < PILOT_TIMEOUT_MS, address }
  }

  function send (msg) {
    app.emit('nmea2000out', msg)
    app.debug('sent: ' + msg)
  }

  /** Runs a command; returns '' on success, otherwise the error message. */
  function command (raw) {
    const cmd = String(raw || '').trim().toLowerCase()
    const pilot = pilotInfo()

    if (cmd === 'standby') {
      // STANDBY has priority: always sent to the last known address
      send(modeMessage(pilot.address, MODES.standby))
      return ''
    }
    if (!pilot.present) return 'Autopilot not found on the NMEA 2000 bus'
    if (cmd === 'auto') {
      send(modeMessage(pilot.address, MODES.auto))
      return ''
    }
    if (KEY_CODES[cmd] !== undefined) {
      if (pilot.state !== 'auto') return 'The autopilot is not in AUTO'
      const now = Date.now()
      if (lastKeyAt && now - lastKeyAt < KEY_MIN_INTERVAL_MS) return 'Too fast: one key at a time'
      if (!keyWindowStart || now - keyWindowStart >= KEY_WINDOW_MS) {
        keyWindowStart = now
        keyWindowDeg = 0
      }
      const deg = Math.abs(Number(cmd))
      if (keyWindowDeg + deg > KEY_WINDOW_MAX_DEG) return 'Maximum 20° every 2 seconds: wait a moment'
      lastKeyAt = now
      keyWindowDeg += deg
      send(keyMessage(pilot.address, KEY_CODES[cmd]))
      return ''
    }
    return 'Unknown autopilot command: ' + cmd
  }

  plugin.start = function (opts) {
    options = opts || {}
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
    app.setPluginStatus('Ready: waiting for commands from MW Captain')
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
  plugin._internals = { modeMessage, keyMessage, command }

  return plugin
}
