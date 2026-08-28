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

Seven tabs, matching the original's shape:

| Tab | What it covers |
| --- | --- |
| Keymap | Profile slots, per-connection assignment, autoswitch, Windows/macOS mode |
| Acceleration | Curve editor — a draggable Bezier graph per device, log scales, import/export |
| Sensor(s) | Pointer feel, twist scroll, rotary encoder, sensor surface quality |
| Effects | Global lighting and battery warnings, plus per-event colour including each Bluetooth profile |
| Import/Export | Download and upload settings as .json, or paste them |
| Raw settings | Every runtime parameter, with its description, range and default |
| Logs | Console with SEND/RECEIVE, millisecond timestamps, download, and a command prompt |

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
| `src/Board.jsx` | keymap profiles, import/export, surface quality |
| `src/Logs.jsx` | the console tab |
| `src/Status.jsx` | header readout: active output, firmware, battery |
| `src/Trackball.jsx` | the three.js preview |
| `src/styles.css` | all of the styling |

Adding a setting is one line in `src/settings.js`; there is no per-setting
component to write. Anything with an `advanced: true` flag folds into a
collapsed section rather than crowding the panel.

## Ranges come from the device

`rtcfg list` reports each key's value, default and permitted range:

```
p2sm/ema_alpha    15  (default: 15, range: [1, 50])
```

Sliders take their bounds from that rather than from anything hard-coded here.
Every bound this project did hard-code was wrong on real firmware — `ema_alpha`
tops out at 50 not 100, `ptr_after_scroll` reaches 5000 not 1000 — and key
names drift too (`p2sm/twist_dy_mag_mul`, not `p2sm/dy_mag_mul`). Controls whose
key the firmware does not report are hidden, so both spellings can be listed
and only the real one appears.

Sensor surface quality is likewise out of whatever the sensor reports — 361 on
one part, 1000 on another — so the good/warning/bad bands scale with it.

## Header status

The bar shows which endpoint is carrying the pointer (USB / Bluetooth /
dongle), the firmware version and the battery, read from `board output` and
`board status`. Output is polled every 5 s and status every 5 min, and both
skip a turn whenever one of your own commands is queued, so a poll never makes
you wait.

## Keeping it quick

Two things dominated first-paint, and both are fixed:

- Effects used to read every event up front — around twenty round trips behind
  a 200 ms inter-command floor before the tab drew anything. It now reads only
  the event list and fetches details on selection, caching as it goes.
- Panels talk to the device when they mount, so a visited tab now stays mounted
  and is hidden rather than torn down. Returning to a tab is instant instead of
  repeating its round trips.

The event picker is grouped (Bluetooth / Layers / Battery / System) so no list
is more than a handful of entries.

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
