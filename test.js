// Prova del plugin senza server: node test.js
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
const plugin = require('./index.js')(app)
plugin.start({ pilotAddress: 204 })

// Modo AUTO: stessi byte del firmware (Command Group Function su 65379, modo 0x0040)
assert.match(plugin._internals.modeMessage(204, 0x40), /,3,126208,0,204,17,01,63,ff,00,f8,04,01,3b,07,03,04,04,40,00,05,ff,ff$/)
// Tasto +1 (0x07) con il complemento 0xf8
assert.match(plugin._internals.keyMessage(204, 0x07), /,7,126720,0,204,22,3b,9f,f0,81,86,21,07,f8,ff/)

const put = (v) => app.put('vessels.self', 'steering.autopilot.mwcaptain.command', v)
assert.equal(put('+1').statusCode, 200)
assert.equal(put('+1').statusCode, 400)          // troppo veloce
sent = []
state = { value: 'standby', timestamp: new Date().toISOString(), $source: 'can0.204' }
assert.equal(put('-10').message, 'Il pilota non è in AUTO')
assert.equal(put('standby').statusCode, 200)
state = { value: 'standby', timestamp: new Date(Date.now() - 10000).toISOString(), $source: 'can0.204' }
assert.equal(put('auto').message, 'Pilota non trovato sul bus NMEA 2000')
assert.equal(put('standby').statusCode, 200)     // STANDBY sempre
assert.equal(sent.length, 2)
assert.equal(put('xyz').statusCode, 400)
// Segnale "pronto" per l'app
assert.equal(app.announced.updates[0].values[0].path, 'steering.autopilot.mwcaptain.status')
assert.equal(app.announced.updates[0].values[0].value, 'ready')
plugin.stop()
console.log('plugin: tutte le prove superate')
