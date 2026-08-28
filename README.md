# Anastesia-UI

Web-based configuration interface for ZMK trackballs / mice.
By **Vaibhav Rajput**.

Tune the device by feel: a 3D trackball sits at the centre of the app and
behaves the way your settings say it will, so you can try a sensitivity or a
dead zone before you write it to the hardware.

## Run

```
npm install
npm run dev       # dev server, with fast refresh
npm run build     # -> dist/index.html, one self-contained offline file
npm run preview   # serve the built file

node src/protocol.js   # self-check the device-output parsers
node src/settings.js   # self-check the settings catalogue
```

Add `?demo` to the URL to open the app with sample values and no device
attached.

## What is in it

| Tab | What it covers |
| --- | --- |
| Feel | Pointer sensitivity, plane rotation, smoothing, report rate, dead zone, and eleven more under Advanced |
| Scroll | Twist-to-scroll speed, direction, thresholds, hysteresis and haptics |
| Lights | Global brightness, animation tick, all six battery warning levels |
| Encoder | Rotary encoder pulse handling (hidden when the board has no `ec11` keys) |
| Curves | Acceleration curve editor — a draggable Bezier graph per device, log scales, import/export |
| Effects | Per-event RGB and vibration, including a colour for each Bluetooth profile |
| Keymap | Profile slots, per-connection assignments, autoswitch, restore defaults |
| Board | Firmware info, sensor surface quality meters, Windows/macOS mode, settings backup |
| Expert | Every runtime parameter the device reports, each with its firmware description |

## Layout

| File | What it is |
| --- | --- |
| `index.html` | Vite entry |
| `src/main.jsx` | mounts React |
| `src/App.jsx` | the shell: connect screen, tabs, save/revert, device log |
| `src/device.js` | USB-serial + BLE transport and the shell protocol |
| `src/protocol.js` | parsers for the device's text output, with a runnable self-check |
| `src/settings.js` | the settings catalogue — one table drives every knob |
| `src/Control.jsx` | renders one knob (range or toggle) |
| `src/Curves.jsx` | acceleration curve editor and its SVG chart |
| `src/Effects.jsx` | per-event RGB / vibration editor |
| `src/Board.jsx` | keymap profiles and board panel |
| `src/Trackball.jsx` | the three.js preview |
| `src/styles.css` | all of the styling |

Adding a setting is one line in `src/settings.js`; there is no per-setting
component to write. Anything with an `advanced: true` flag folds into a
collapsed section rather than crowding the panel.

## Talking to the device

The firmware exposes a text shell. Connections are USB serial (vendor `0x11`,
product `0x07`, 460800 baud) or BLE (service `c901c4e9-...`). Commands are lines
like `rtcfg set p2sm/twist_thres 40`; responses end at the shell prompt
(`endgame$`, `uart:~$`, `zmk$`, `zmk:~$`).

Details worth keeping, all covered by `node src/protocol.js`:

- `rtcfg list` prints `<key>  <value>  (default: <n>)` and keys may have three
  segments (`bst/<name>/s0_div`) — a parser anchored at end of line returns
  nothing at all.
- Curve segments are eight integers scaled by 100 in the order
  **start, end, cp1, cp2** — the end point comes before the control points.
- Only `layer` events support solid/blink/breathe; every other RGB event is
  flash-only.
- Commands go to USB one word at a time, because the device's line editor drops
  bytes when a long command arrives in a single burst; there is also a 200 ms
  floor between commands. Neither is stylistic.

Requires a Chromium-based browser for Web Serial / Web Bluetooth. Without
either, the app still opens in demo mode.

## Still not built

The shell commands are documented above and the previous build is in git
(`git show main:src/app.js`):

- storage-partition backup and restore over USB (`board backup`, `board restore`)
- the live sensor surface heat-map stream (`sensor stream --on`)
- per-encoder-ID settings (step, min/max step, wrap, feedback pattern)
- per-keymap sensor scaling, the `bst/<name>/s0_mult` family — these are
  editable under Expert, just without a dedicated screen

Everything else the firmware reports through `rtcfg` is reachable under Expert.
