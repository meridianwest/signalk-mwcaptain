// Autopilot drivers available in the plugin settings. The first one is the default.
// To add a brand: create drivers/<brand>.js (see the README, "Adding an autopilot brand")
// and add it to this list.
module.exports = [
  require('./raymarine')
]
