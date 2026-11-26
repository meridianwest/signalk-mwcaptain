# Changelog

## 1.0.0 – unreleased
- First public version, published as `signalk-mwcaptain` (previously used privately as
  `signalk-mwcaptain-pilot`).
- AUTO / STANDBY and ±1° / ±10° course changes for Raymarine Evolution / SmartPilot over NMEA 2000.
- Safety rules shared with the MW Box: STANDBY always sent; AUTO and course changes only with the
  autopilot seen on the bus in the last 5 s; course changes only in AUTO, at most one every 0.4 s and
  20° every 2 s.
- Settings, status and error messages in English.
- Modular code: a brand-independent core (`lib/core.js`) with the PUT handler, the `ready` status and
  all the safety rules, and one driver per autopilot brand (`drivers/raymarine.js`). New *Autopilot*
  setting to choose the driver (today only Raymarine, the default); settings saved before keep working.
  The core checks every message a driver builds and is the only part that sends on the bus.
  Raymarine messages are byte-for-byte the same as before.
- README: "Adding an autopilot brand" (driver interface, recording messages, harbour tests).
