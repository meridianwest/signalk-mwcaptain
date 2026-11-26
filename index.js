/*
  signalk-mwcaptain — comando del pilota Raymarine dall'app MWCaptain via Signal K.

  L'app manda un PUT autenticato (token Signal K con permesso di scrittura) su
      /signalk/v1/api/vessels/self/steering/autopilot/mwcaptain/command
  con {"value": "standby" | "auto" | "-1" | "+1" | "-10" | "+10"}.
  Il plugin li trasforma negli stessi messaggi NMEA 2000 che manda MWBox (firmware
  Autopilot.cpp):
    - modo (AUTO/STANDBY): PGN 126208, Command Group Function sul PGN 65379 (Raymarine)
    - correzioni ±1° / ±10°: PGN 126720, tasti del comando p70
  Sicurezza (come MWBox):
    - STANDBY sempre accettato (anche se il pilota tace da poco), inviato all'ultimo indirizzo noto
    - AUTO e correzioni solo se il pilota è visto sul bus da meno di 5 s
    - correzioni solo con il pilota in AUTO, al massimo una ogni 0,4 s e 20° ogni 2 s
  Ogni 5 s il plugin pubblica steering.autopilot.mwcaptain.status = "ready": l'app lo vede
  nel flusso dei dati e attiva i comandi del pilota; senza, resta in sola lettura.
  Lo stato del pilota lo legge Signal K stesso (steering.autopilot.state e
  steering.autopilot.target.headingMagnetic, dai PGN Raymarine 65379 e 65360).
*/

const RAYMARINE = 1851
const KEY_CODES = { '-1': 0x05, '-10': 0x06, '+1': 0x07, '+10': 0x08 }
const MODES = { standby: 0x0000, auto: 0x0040 }
const KEY_MIN_INTERVAL_MS = 400
const KEY_WINDOW_MS = 2000
const KEY_WINDOW_MAX_DEG = 20
const PILOT_TIMEOUT_MS = 5000
const PUT_PATH = 'steering.autopilot.mwcaptain.command'
// Segnale per l'app: il plugin c'è ed è attivo (senza, l'app usa Signal K in sola lettura)
const STATUS_PATH = 'steering.autopilot.mwcaptain.status'
const STATUS_EVERY_MS = 5000

module.exports = function (app) {
  const plugin = {
    id: 'signalk-mwcaptain',
    name: 'MW Captain Plugin',
    description: 'MW Captain Plugin: comandi del pilota Raymarine dall\'app MW Captain (AUTO, STANDBY, ±1°, ±10°)'
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
        title: 'Indirizzo NMEA 2000 del pilota (usato se Signal K non lo ricava dai messaggi)',
        default: 204
      },
      sourceAddress: {
        type: 'number',
        title: 'Indirizzo del server sul bus (0 = quello del gateway)',
        default: 0
      }
    }
  }

  const hex = (b) => b.toString(16).padStart(2, '0')

  /** Messaggio nel formato Actisense testo che canboatjs accetta su 'nmea2000out'. */
  function n2kString (prio, pgn, dst, bytes) {
    const src = options.sourceAddress || 0
    return `${new Date().toISOString()},${prio},${pgn},${src},${dst},${bytes.length},${bytes.map(hex).join(',')}`
  }

  function u16 (v) { return [v & 0xff, (v >> 8) & 0xff] }

  function modeMessage (dst, mode) {
    const bytes = [
      0x01, // Command
      0x63, 0xff, 0x00, // PGN comandato: 65379
      0xf8, // priorità invariata
      0x04, // 4 parametri
      0x01, ...u16(RAYMARINE), // 1: costruttore
      0x03, 0x04, // 3: settore marino
      0x04, ...u16(mode), // 4: modo
      0x05, 0xff, 0xff // 5: sotto-modo
    ]
    return n2kString(3, 126208, dst, bytes)
  }

  function keyMessage (dst, code) {
    const head = [0x3b, 0x9f, 0xf0, 0x81, 0x86, 0x21]
    const tail = [0xff, 0xff, 0xff, 0xff, 0xff, 0xc1, 0xc2, 0xcd, 0x66, 0x80, 0xd3, 0x42, 0xb1, 0xc8]
    return n2kString(7, 126720, dst, [...head, code, 0xff - code, ...tail])
  }

  /** Stato e indirizzo del pilota, dal valore steering.autopilot.state di Signal K. */
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
    app.debug('inviato: ' + msg)
  }

  /** Esegue un comando; restituisce '' se va bene, altrimenti il messaggio d'errore. */
  function command (raw) {
    const cmd = String(raw || '').trim().toLowerCase()
    const pilot = pilotInfo()

    if (cmd === 'standby') {
      // STANDBY ha la precedenza: sempre inviato all'ultimo indirizzo noto
      send(modeMessage(pilot.address, MODES.standby))
      return ''
    }
    if (!pilot.present) return 'Pilota non trovato sul bus NMEA 2000'
    if (cmd === 'auto') {
      send(modeMessage(pilot.address, MODES.auto))
      return ''
    }
    if (KEY_CODES[cmd] !== undefined) {
      if (pilot.state !== 'auto') return 'Il pilota non è in AUTO'
      const now = Date.now()
      if (lastKeyAt && now - lastKeyAt < KEY_MIN_INTERVAL_MS) return 'Troppo veloce: un tasto alla volta'
      if (!keyWindowStart || now - keyWindowStart >= KEY_WINDOW_MS) {
        keyWindowStart = now
        keyWindowDeg = 0
      }
      const deg = Math.abs(Number(cmd))
      if (keyWindowDeg + deg > KEY_WINDOW_MAX_DEG) return 'Massimo 20° ogni 2 secondi: attendi un attimo'
      lastKeyAt = now
      keyWindowDeg += deg
      send(keyMessage(pilot.address, KEY_CODES[cmd]))
      return ''
    }
    return 'Comando del pilota sconosciuto: ' + cmd
  }

  plugin.start = function (opts) {
    options = opts || {}
    // Il server controlla il token: un PUT arriva qui solo con permesso di scrittura
    app.registerPutHandler('vessels.self', PUT_PATH, (context, path, value, callback) => {
      const error = command(value)
      if (error) {
        app.setPluginError(error)
        return { state: 'COMPLETED', statusCode: 400, message: error }
      }
      app.setPluginStatus('Ultimo comando: ' + value)
      return { state: 'COMPLETED', statusCode: 200 }
    }, plugin.id)
    app.setPluginStatus('Pronto: in attesa dei comandi di MWCaptain')
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

  // Per i test
  plugin._internals = { modeMessage, keyMessage, command }

  return plugin
}
