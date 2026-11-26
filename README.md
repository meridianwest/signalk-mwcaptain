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
| Autopilot NMEA 2000 address | 204 | Used only if Signal K cannot detect it from the autopilot messages |
| Server address on the bus | 0 | 0 = the gateway's own address |

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
the command was refused (for example the autopilot is not in AUTO). Messages are currently in Italian.

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
npm test        # checks message bytes and safety rules, no server needed
```

Releases are published to npm by GitHub Actions when a GitHub release `vX.Y.Z` is published
(the tag must match `package.json`).

## Licence

MIT © Meridian West — see [LICENSE](LICENSE).
