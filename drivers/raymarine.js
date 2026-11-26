/*
  Raymarine Evolution / SmartPilot driver (NMEA 2000).

  Sends the same NMEA 2000 messages as the Meridian West MW Box (firmware Autopilot.cpp):
    - mode (AUTO/STANDBY): PGN 126208, Command Group Function on PGN 65379 (Raymarine)
    - ±1° / ±10° course changes: PGN 126720, p70 control head keys
  The autopilot state is read by Signal K itself (steering.autopilot.state and
  steering.autopilot.target.headingMagnetic, decoded by canboatjs from Raymarine PGNs 65379
  and 65360). The autopilot address is taken from the source of steering.autopilot.state,
  otherwise from the pilotAddress setting (default 204).

  This file only builds messages: the safety rules live in lib/core.js. See the README section
  "Adding an autopilot brand" for the driver interface.
*/

const RAYMARINE = 1851
const DEFAULT_ADDRESS = 204
const MODES = { standby: 0x0000, auto: 0x0040 }
const KEY_CODES = { '-1': 0x05, '-10': 0x06, '+1': 0x07, '+10': 0x08 }

function u16 (v) { return [v & 0xff, (v >> 8) & 0xff] }

/** PGN 126208 Command Group Function on PGN 65379: set the autopilot mode (raw mode code). */
function modeFrame (dst, modeCode) {
  return {
    prio: 3,
    pgn: 126208,
    dst,
    bytes: [
      0x01, // Command
      0x63, 0xff, 0x00, // commanded PGN: 65379
      0xf8, // priority unchanged
      0x04, // 4 parameters
      0x01, ...u16(RAYMARINE), // 1: manufacturer
      0x03, 0x04, // 3: marine industry
      0x04, ...u16(modeCode), // 4: mode
      0x05, 0xff, 0xff // 5: sub-mode
    ]
  }
}

/** PGN 126720: p70 control head key press (raw key code). */
function keyFrame (dst, code) {
  const head = [0x3b, 0x9f, 0xf0, 0x81, 0x86, 0x21]
  const tail = [0xff, 0xff, 0xff, 0xff, 0xff, 0xc1, 0xc2, 0xcd, 0x66, 0x80, 0xd3, 0x42, 0xb1, 0xc8]
  return { prio: 7, pgn: 126720, dst, bytes: [...head, code, 0xff - code, ...tail] }
}

module.exports = {
  id: 'raymarine',
  name: 'Raymarine Evolution / SmartPilot (NMEA 2000)',
  pgns: {
    send: [126208, 126720],
    receive: [65379, 65360]
  },

  /**
   * @param {object} ctx  { getSelfPath(path), debug(msg), options } — see lib/core.js
   */
  create (ctx) {
    return {
      /** { mode, seenAt, address } from the Signal K value steering.autopilot.state. */
      state () {
        const st = ctx.getSelfPath('steering.autopilot.state')
        const mode = st && st.value !== undefined ? st.value : undefined
        const seenAt = st && st.timestamp ? Date.parse(st.timestamp) : 0
        let address = ctx.options.pilotAddress || DEFAULT_ADDRESS
        const m = /\.(\d+)$/.exec((st && st.$source) || '')
        if (m) address = Number(m[1])
        return { mode, seenAt, address }
      },
      modeMessage (mode, pilot) {
        return modeFrame(pilot.address, MODES[mode])
      },
      keyMessage (delta, pilot) {
        return keyFrame(pilot.address, KEY_CODES[(delta > 0 ? '+' : '') + delta])
      }
    }
  },

  // Low-level builders, exported for the tests
  _frames: { modeFrame, keyFrame, MODES, KEY_CODES }
}
