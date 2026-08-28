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
```

Add `?demo` to the URL to open the app with sample values and no device
attached.

## Layout

| File | What it is |
| --- | --- |
| `index.html` | Vite entry |
| `src/main.jsx` | mounts React |
| `src/App.jsx` | the shell: connect screen, tabs, save/revert, device log |
| `src/device.js` | USB-serial + BLE transport and the shell protocol |
| `src/settings.js` | the settings catalogue — one table drives every control |
| `src/Control.jsx` | renders one knob (range or toggle) |
| `src/Trackball.jsx` | the three.js preview |
| `src/styles.css` | all of the styling |

Adding a setting is one line in `src/settings.js`; there is no per-setting
component to write.

## Talking to the device

The firmware exposes a text shell. Connections are USB serial (vendor `0x11`,
product `0x07`, 460800 baud) or BLE (service `c901c4e9-…`). Commands are lines
like `rtcfg set p2sm/twist_thres 40`; responses end at the shell prompt
(`endgame$`, `uart:~$`, `zmk$`, `zmk:~$`).

Two hardware quirks in `src/device.js` are deliberate and should not be
"cleaned up": commands are written to USB one word at a time, because the
device's line editor drops bytes when a long command arrives in a single
burst; and there is a 200 ms floor between commands.

Requires a Chromium-based browser for Web Serial / Web Bluetooth. Without
either, the app still opens in demo mode.

## Not carried over from the previous build

The old UI was an opaque 930 KB minified bundle with no sources; this is a
rewrite of the interface against the same protocol. These areas were left out
rather than half-rebuilt — the shell commands for them are documented above and
in git history (`git show main:src/app.js`):

- keymap profiles, output assignments, bistable slots (`keymap …`, `bistable …`)
- acceleration curve editor (`curve …`)
- RGB per-event animations and colours (`argb evt …`) — global brightness and
  battery warnings are here, the per-event editor is not
- storage-partition backup / restore (`board backup`, `board restore`)
- the live sensor surface heat-map (`sensor stream --on`)

`rtcfg`-backed parameters that have no curated control are all reachable and
editable under the **Expert** tab, so nothing is unreachable.
