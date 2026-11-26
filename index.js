/*
  signalk-mwcaptain — autopilot control from the MW Captain app via Signal K.

  lib/core.js   brand-independent part: PUT handler, "ready" status, safety rules
  drivers/*.js  one file per autopilot brand: reads the state, builds the NMEA 2000 messages
                (today only Raymarine Evolution / SmartPilot)
*/

const createPlugin = require('./lib/core')
const drivers = require('./drivers')

module.exports = function (app) {
  return createPlugin(app, drivers)
}
