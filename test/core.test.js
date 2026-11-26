// Core safety rules with a fake driver, without a server: node test/core.test.js
// Whatever the driver, the rules in lib/core.js must hold.
const assert = require('assert')
const createPlugin = require('../lib/core.js')

const realNow = Date.now
let clock = 1_000_000
Date.now = () => clock

// Fake driver: reports whatever the test sets in `pilot`, records every call
let pilot = { mode: 'auto', seenAt: clock, address: 42 }
let calls = []
let output = null // when not null, returned instead of the normal message ({ v })
const fake = {
  id: 'fake',
  name: 'Fake autopilot',
  pgns: { send: [65000], receive: [] },
  create (ctx) {
    fake.ctx = ctx
    return {
      state: () => pilot,
      modeMessage (mode, p) {
        calls.push(['mode', mode, p.address])
        return output ? output.v : { prio: 2, pgn: 65000, dst: p.address, bytes: [mode === 'auto' ? 1 : 0] }
      },
      keyMessage (delta, p) {
        calls.push(['key', delta, p.address])
        return output ? output.v : [{ prio: 2, pgn: 65000, dst: p.address, bytes: [0x10, delta & 0xff] }]
      }
    }
  }
}
const other = { id: 'other', name: 'Other', create: () => ({ state: () => ({}), modeMessage () {}, keyMessage () {} }) }

let sent = []
let errors = []
const app = {
  emit: (ev, msg) => sent.push([ev, msg]),
  handleMessage: (id, delta) => { app.announced = delta },
  debug: () => {}, setPluginStatus: () => {}, setPluginError: (e) => errors.push(e),
  getSelfPath: () => undefined,
  registerPutHandler: (ctx, path, fn) => { app.putPath = path; app.put = fn }
}
const put = (v) => app.put('vessels.self', app.putPath, v)
const reset = () => { sent = []; calls = []; output = null }

// --- configuration: default driver, saved settings without "driver" ---
const plugin = createPlugin(app, [fake, other])
assert.equal(plugin.schema.properties.driver.default, 'fake')
assert.deepEqual(plugin.schema.properties.driver.enum, ['fake', 'other'])
plugin.start({ sourceAddress: 9 })
assert.equal(app.putPath, 'steering.autopilot.mwcaptain.command')
assert.equal(app.announced.updates[0].values[0].path, 'steering.autopilot.mwcaptain.status')
assert.equal(app.announced.updates[0].values[0].value, 'ready')
assert.ok(Object.isFrozen(fake.ctx.options))
assert.equal(fake.ctx.app, undefined) // the driver gets no handle to send on the bus

// --- the core formats and sends the driver's messages ---
reset()
assert.equal(put('auto').statusCode, 200)
assert.deepEqual(calls, [['mode', 'auto', 42]])
assert.equal(sent.length, 1)
assert.match(sent[0][1], /,2,65000,9,42,1,01$/)

// --- STANDBY always sent, even with the autopilot silent or never seen ---
for (const p of [{ mode: 'auto', seenAt: clock - 60000, address: 42 }, { mode: undefined, seenAt: 0, address: 42 }, { address: 42 }]) {
  pilot = p
  reset()
  assert.equal(put('standby').statusCode, 200)
  assert.equal(put(' STANDBY ').statusCode, 200)
  assert.equal(sent.length, 2)
}

// --- AUTO and course changes only with the autopilot seen in the last 5 s ---
pilot = { mode: 'auto', seenAt: clock - 5000, address: 42 }
reset()
assert.equal(put('auto').message, 'Autopilot not found on the NMEA 2000 bus')
assert.equal(put('+1').message, 'Autopilot not found on the NMEA 2000 bus')
assert.equal(sent.length, 0)
assert.equal(calls.length, 0)
pilot = { mode: 'auto', seenAt: clock - 4999, address: 42 }
assert.equal(put('auto').statusCode, 200)

// --- course changes only in AUTO ---
for (const mode of ['standby', 'wind', 'route', 'AUTO', undefined]) {
  pilot = { mode, seenAt: clock, address: 42 }
  reset()
  assert.equal(put('+1').statusCode, 400, String(mode))
  assert.equal(sent.length, 0)
  assert.equal(calls.length, 0)
}

// --- at most one course change every 0.4 s ---
pilot = { mode: 'auto', seenAt: clock, address: 42 }
clock += 10000; pilot.seenAt = clock
reset()
assert.equal(put('+1').statusCode, 200)
assert.deepEqual(calls, [['key', 1, 42]])
clock += 399
assert.equal(put('-1').message, 'Too fast: one key at a time')
clock += 1
assert.equal(put('-1').statusCode, 200)
assert.equal(sent.length, 2)

// --- at most 20° every 2 s ---
clock += 10000; pilot.seenAt = clock
reset()
assert.equal(put('+10').statusCode, 200) // 10
clock += 400
assert.equal(put('-10').statusCode, 200) // 20
clock += 400
assert.equal(put('+1').message, 'Maximum 20° every 2 seconds: wait a moment')
clock += 1200 // 2 s after the first key: new window
pilot.seenAt = clock
assert.equal(put('+10').statusCode, 200)
assert.deepEqual(calls.map((c) => c[1]), [10, -10, 10])
assert.equal(sent.length, 3)

// --- a broken driver cannot send malformed messages, and a refused key does not count ---
const bad = [undefined, null, 'raw', [], { prio: 9, pgn: 1, dst: 1, bytes: [1] }, { prio: 1, pgn: 1, dst: 300, bytes: [1] },
  { prio: 1, pgn: 1, dst: 1, bytes: [256] }, { prio: 1, pgn: 1, dst: 1, bytes: [] }, [{ prio: 1, pgn: 1, dst: 1, bytes: [1] }, 'raw']]
for (const b of bad) {
  clock += 10000; pilot.seenAt = clock
  reset()
  output = { v: b }
  for (const cmd of ['standby', 'auto', '+1']) {
    assert.match(put(cmd).message, /^Autopilot driver error: /, JSON.stringify(b))
  }
  assert.equal(sent.length, 0)
}
output = null
assert.equal(put('+1').statusCode, 200) // the failed '+1' above did not start the 0.4 s timer

// --- unknown commands ---
pilot = { mode: 'auto', seenAt: clock, address: 42 }
assert.equal(put('xyz').message, 'Unknown autopilot command: xyz')
assert.equal(put('+5').message, 'Unknown autopilot command: +5')
assert.equal(put('').message, 'Unknown autopilot command: ')
plugin.stop()

// --- a driver that throws is reported, nothing is sent ---
const thrower = { id: 't', name: 'T', create: () => ({ state () { throw new Error('boom') }, modeMessage () {}, keyMessage () {} }) }
const p3 = createPlugin(app, [thrower])
p3.start({})
reset()
assert.equal(put('standby').message, 'Autopilot driver error: boom')
assert.equal(sent.length, 0)
p3.stop()

// --- driver selection and validation ---
app.put = null
errors = []
const p4 = createPlugin(app, [fake, other])
p4.start({ driver: 'nope' })
assert.equal(app.put, null) // no PUT handler, no "ready": the app stays read-only
assert.deepEqual(errors, ['Unknown autopilot driver: nope'])
p4.stop()
const p5 = createPlugin(app, [fake, { id: 'half', name: 'Half', create: () => ({ state () {} }) }])
p5.start({ driver: 'half' })
assert.equal(app.put, null)
assert.match(errors[1], /missing modeMessage\(\)/)
p5.stop()
assert.throws(() => createPlugin(app, [{ id: 'x', name: 'X' }]), /missing create\(\)/)

Date.now = realNow
console.log('core: all tests passed')
