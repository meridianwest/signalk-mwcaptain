# MW Captain Plugin for Signal K

Signal K server plugin that lets the **MW Captain** app (iOS and Android) control a
**Raymarine Evolution / SmartPilot** autopilot over **NMEA 2000**: AUTO, STANDBY and ±1° / ±10°
course changes. It sends the same NMEA 2000 messages as the Meridian West **MW Box**, with the same
safety rules, and needs no other third-party plugin.

It runs on any Signal K server connected to the NMEA 2000 bus, for example a **Victron Cerbo GX**
with Venus OS Large.

> ## ⚠️ Safety first — read before use
>
> - This plugin **sends commands to your autopilot**. A wrong command can change your boat's course.
> - **Test it moored, in harbour**, with the autopilot in STANDBY and the Raymarine control head
>   (p70/p70s) within reach, before any use at sea.
> - **STANDBY on the control head always wins.** Keep a person on watch at all times.
> - Only grant write access to devices you trust (see *Security* below).
> - Provided **as is, without any warranty** (MIT licence). You use it at your own risk and remain
>   fully responsible for the navigation of your vessel.

## What it does

| App command | NMEA 2000 message |
|---|---|
| `standby`, `auto` | PGN 126208 (Command Group Function) on Raymarine PGN 65379, mode 0x0000 / 0x0040 |
| `-1`, `+1`, `-10`, `+10` | PGN 126720, p70 key codes (0x05, 0x07, 0x06, 0x08) |

### Safety rules (same as the MW Box)

- **STANDBY is always sent**, even if the autopilot has been silent for a moment (to the last known address).
- **AUTO and course changes** only if the autopilot was seen on the bus in the last **5 s**.
- **Course changes only in AUTO**, at most **one every 0.4 s** and **20° every 2 s**.
- No "tack" / wind-vane manoeuvre.
- The autopilot state is read by Signal K itself (`steering.autopilot.state`,
  `steering.autopilot.target.headingMagnetic`); the autopilot address is taken from the source of
  those values, otherwise from the plugin setting (default 204).

## Requirements

- Signal K server (Node.js 18 or later).
- An **NMEA 2000 data connection of type canboatjs** that can **send** on the bus
  (*Server › Data Connections*). On a Cerbo GX this is the VE.Can / NMEA 2000 interface. If the bus
  only reaches Signal K through Victron D-Bus data, commands cannot be sent.
- Signal K **security enabled** (an admin user), so that the app can request write access.

## Installation

### From the Signal K App Store (recommended)

*Appstore › Available*, search **MW Captain Plugin** (`signalk-mwcaptain`), *Install*, then restart
the server.

### Manual (for example on a Cerbo GX)

```sh
ssh root@venus.local
cd /data/conf/signalk && npm install signalk-mwcaptain
svc -t /service/signalk-server
```

## Configuration

*Server › Plugin Config › MW Captain Plugin*: enable it and, if needed, set:

| Setting | Default | Meaning |
|---|---|---|
| Autopilot | Raymarine Evolution / SmartPilot (NMEA 2000) | The autopilot driver (today the only one available) |
| Autopilot NMEA 2000 address | 204 | Used only if Signal K cannot detect it from the autopilot messages |
| Server address on the bus | 0 | 0 = the gateway's own address |

Settings saved by earlier versions (without the *Autopilot* choice) keep working unchanged: they
use the Raymarine driver.

## Using it from MW Captain

1. Connect the app to your Signal K server (same network as the boat).
2. In the app: *Request write access*, then approve it in Signal K under *Security › Access Requests*
   with **read/write** permission.
3. Every 5 s the plugin publishes `steering.autopilot.mwcaptain.status = "ready"`: the app shows the
   autopilot controls only when it sees this value. Without the plugin the app stays read-only.

## API

```
PUT /signalk/v1/api/vessels/self/steering/autopilot/mwcaptain/command
Authorization: Bearer <token>
{"value": "standby" | "auto" | "-1" | "+1" | "-10" | "+10"}
```

Answer: `{"state":"COMPLETED","statusCode":200}`, or `statusCode` 400 with a `message` explaining why
the command was refused:

| `message` | When |
|---|---|
| `Autopilot not found on the NMEA 2000 bus` | AUTO or a course change, autopilot not seen in the last 5 s |
| `The autopilot is not in AUTO` | course change while in STANDBY |
| `Too fast: one key at a time` | less than 0.4 s since the previous course change |
| `Maximum 20° every 2 seconds: wait a moment` | more than 20° within 2 s |
| `Unknown autopilot command: …` | any other value |
| `Autopilot driver error: …` | the driver failed or built an invalid message (nothing was sent) |

## Adding an autopilot brand

The plugin is split in two parts:

| Part | Files | What it does |
|---|---|---|
| Core | `lib/core.js` | PUT handler on `steering.autopilot.mwcaptain.command`, the `ready` status, **all the safety rules**, formatting and sending of the NMEA 2000 messages |
| Drivers | `drivers/*.js` | One file per autopilot brand: reads the autopilot state and builds the messages |

Supported today: **Raymarine Evolution / SmartPilot** (`drivers/raymarine.js`).

**Not supported yet** (contributions welcome):

- Navico: **B&G, Simrad, Lowrance**
- **Garmin** (Reactor)
- **pypilot**

### Driver interface

A driver is a CommonJS module listed in `drivers/index.js`:

```js
module.exports = {
  id: 'mybrand',                          // stored in the plugin settings, never change it
  name: 'MyBrand Model X (NMEA 2000)',    // shown in Plugin Config
  pgns: { send: [126208], receive: [65379] }, // documentation only
  create (ctx) {                          // ctx = { getSelfPath(path), debug(msg), options }
    return {
      state () {                          // called before every command
        return { mode, seenAt, address }  // mode: 'auto' | 'standby' | other string | undefined
      },                                  // seenAt: ms timestamp of the last autopilot message
      modeMessage (mode, pilot) {          // mode: 'auto' | 'standby'
        return { prio, pgn, dst, bytes }  // one message or an array of messages
      },
      keyMessage (delta, pilot) {          // delta: -1 | +1 | -10 | +10 (degrees)
        return { prio, pgn, dst, bytes }
      }
    }
  }
}
```

- `state().mode` must be exactly `'auto'` when the autopilot is steering a compass heading:
  the core only allows course changes in that case.
- `pilot` is `{ mode, address, present }` as seen by the core.
- A message is `{ prio: 0-7, pgn, dst: 0-255, bytes: [0-255, …] }`. The core checks it, adds the
  source address and sends it on `nmea2000out`. A malformed message or an exception is refused
  with `Autopilot driver error: …` and nothing is sent.
- A driver **never sends anything itself** and does not get the `app` object. The safety rules
  (STANDBY always sent, autopilot seen in the last 5 s, course changes only in AUTO, one every
  0.4 s, 20° every 2 s) are in the core and apply to every driver: do not duplicate or change them
  in a driver.
- Add tests in `test/` (see `test/raymarine.test.js`): the exact bytes of every message.

### Recording the messages of your control head

Build the driver from **real messages**, not from guesses:

1. Connect a computer to the NMEA 2000 bus (for example a CAN adapter with `can0`, or an Actisense
   NGT-1) next to the autopilot control head.
2. Record the bus while pressing, one at a time and with a pause between them, AUTO, STANDBY,
   -1, +1, -10, +10 on the control head:
   ```sh
   candump can0 | tee keys.log | candump2analyzer | analyzer -json > keys.json
   ```
   (`candump` is from can-utils, `candump2analyzer` and `analyzer` from
   [canboat](https://github.com/canboat/canboat); with an NGT-1 use canboat's `actisense-serial`
   instead of `candump`).
3. Note the PGN, the destination and the bytes of each press, and which PGN reports the autopilot
   mode and heading (so that Signal K fills `steering.autopilot.state`).
4. Write the driver and a test with those exact bytes.

### Harbour test requirements

Before opening a pull request, test the driver **moored in harbour**, engine off or in neutral,
with the control head within reach and a person ready to press STANDBY on it:

- STANDBY from the app works from every mode, also right after the autopilot was switched on;
- AUTO from the app engages the autopilot on the current heading;
- each of -1, +1, -10, +10 changes the target heading by exactly that amount, in the right direction;
- course changes are refused in STANDBY, and AUTO is refused with the autopilot switched off;
- STANDBY on the control head always overrides the app.

Write in the pull request which autopilot, computer and control head (models and software versions)
you tested with. Pull requests are welcome at
[meridianwest/signalk-mwcaptain](https://github.com/meridianwest/signalk-mwcaptain/pulls).

## Upgrading from `signalk-mwcaptain-pilot`

Early private versions were called `signalk-mwcaptain-pilot`. Do this **once**, with the autopilot in
STANDBY. **Never keep both installed**: both would answer the app's commands.

```sh
ssh root@venus.local
cd /data/conf/signalk
cp plugin-config-data/signalk-mwcaptain-pilot.json plugin-config-data/signalk-mwcaptain.json 2>/dev/null
npm uninstall signalk-mwcaptain-pilot
npm install signalk-mwcaptain
svc -t /service/signalk-server
```

Then check in *Server › Plugin Config* that there is **only one** MW Captain Plugin, enabled, with the
right autopilot address.

## Development

```sh
npm test        # core safety rules with a fake driver + Raymarine message bytes, no server needed
```

Releases are published to npm by GitHub Actions when a GitHub release `vX.Y.Z` is published
(the tag must match `package.json`).

## Licence

MIT © Meridian West — see [LICENSE](LICENSE).
