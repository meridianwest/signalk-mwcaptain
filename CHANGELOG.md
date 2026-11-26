# Changelog

## 1.0.0 – unreleased
- First public version, published as `signalk-mwcaptain` (previously used privately as
  `signalk-mwcaptain-pilot`).
- AUTO / STANDBY and ±1° / ±10° course changes for Raymarine Evolution / SmartPilot over NMEA 2000.
- Safety rules shared with the MW Box: STANDBY always sent; AUTO and course changes only with the
  autopilot seen on the bus in the last 5 s; course changes only in AUTO, at most one every 0.4 s and
  20° every 2 s.
