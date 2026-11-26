// Raymarine driver and plugin end-to-end, without a server: node test/raymarine.test.js
const assert = require('assert')
let sent = []
let state = { value: 'auto', timestamp: new Date().toISOString(), $source: 'can0.204' }
const app = {
  emit: (ev, msg) => sent.push([ev, msg]),
  handleMessage: (id, delta) => { app.announced = delta },
  debug: () => {}, setPluginStatus: () => {}, setPluginError: () => {},
  getSelfPath: (p) => (p === 'steering.autopilot.state' ? state : undefined),
  registerPutHandler: (ctx, path, fn) => { app.put = fn }
}
const plugin = require('../index.js')(app)
const { modeFrame, keyFrame } = require('../drivers/raymarine.js')._frames
const { format } = plugin._internals
plugin.start({ pilotAddress: 204 }) // settings saved before drivers existed: no "driver" key

// AUTO mode: same bytes as the firmware (Command Group Function on 65379, mode 0x0040)
assert.match(format(modeFrame(204, 0x40)), /,3,126208,0,204,17,01,63,ff,00,f8,04,01,3b,07,03,04,04,40,00,05,ff,ff$/)
// +1 key (0x07) with its complement 0xf8
assert.match(format(keyFrame(204, 0x07)), /,7,126720,0,204,22,3b,9f,f0,81,86,21,07,f8,ff/)

const put = (v) => app.put('vessels.self', 'steering.autopilot.mwcaptain.command', v)
assert.equal(put('+1').statusCode, 200)
assert.equal(put('+1').statusCode, 400)          // too fast
sent = []
state = { value: 'standby', timestamp: new Date().toISOString(), $source: 'can0.204' }
assert.equal(put('-10').message, 'The autopilot is not in AUTO')
assert.equal(put('standby').statusCode, 200)
state = { value: 'standby', timestamp: new Date(Date.now() - 10000).toISOString(), $source: 'can0.204' }
assert.equal(put('auto').message, 'Autopilot not found on the NMEA 2000 bus')
assert.equal(put('standby').statusCode, 200)     // STANDBY always
assert.equal(sent.length, 2)
assert.equal(put('xyz').statusCode, 400)
// "ready" signal for the app
assert.equal(app.announced.updates[0].values[0].path, 'steering.autopilot.mwcaptain.status')
assert.equal(app.announced.updates[0].values[0].value, 'ready')
plugin.stop()

// All commands through the PUT, exact bytes (identical to version 1.0.0 before the driver split)
const ALL = {
  standby: ',3,126208,33,115,17,01,63,ff,00,f8,04,01,3b,07,03,04,04,00,00,05,ff,ff',
  auto: ',3,126208,33,115,17,01,63,ff,00,f8,04,01,3b,07,03,04,04,40,00,05,ff,ff',
  '-1': ',7,126720,33,115,22,3b,9f,f0,81,86,21,05,fa,ff,ff,ff,ff,ff,c1,c2,cd,66,80,d3,42,b1,c8',
  '-10': ',7,126720,33,115,22,3b,9f,f0,81,86,21,06,f9,ff,ff,ff,ff,ff,c1,c2,cd,66,80,d3,42,b1,c8',
  '+1': ',7,126720,33,115,22,3b,9f,f0,81,86,21,07,f8,ff,ff,ff,ff,ff,c1,c2,cd,66,80,d3,42,b1,c8',
  '+10': ',7,126720,33,115,22,3b,9f,f0,81,86,21,08,f7,ff,ff,ff,ff,ff,c1,c2,cd,66,80,d3,42,b1,c8'
}
const realNow = Date.now
let clock = realNow()
Date.now = () => clock
const p2 = require('../index.js')(app)
p2.start({ driver: 'raymarine', pilotAddress: 204, sourceAddress: 33 })
for (const [cmd, tail] of Object.entries(ALL)) {
  state = { value: 'auto', timestamp: new Date(clock).toISOString(), $source: 'can0.115' } // address from the source
  sent = []
  clock += 2000
  assert.equal(put(cmd).statusCode, 200, cmd)
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'nmea2000out')
  assert.ok(sent[0][1].endsWith(tail), cmd + ': ' + sent[0][1])
}
// No address in the source: the pilotAddress setting is used
state = { value: 'auto', timestamp: new Date(clock).toISOString(), $source: 'derived-data' }
sent = []
clock += 2000
assert.equal(put('standby').statusCode, 200)
assert.ok(sent[0][1].includes(',126208,33,204,'))
p2.stop()
Date.now = realNow

// Settings page: Raymarine is the only driver and the default
assert.deepEqual(plugin.schema.properties.driver.enum, ['raymarine'])
assert.equal(plugin.schema.properties.driver.default, 'raymarine')
assert.equal(plugin.schema.properties.driver.enumNames[0], 'Raymarine Evolution / SmartPilot (NMEA 2000)')
console.log('raymarine: all tests passed')
