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

node src/device.js     # self-check reply completion
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
| Sensor(s) | Surface quality, pointer feel, twist scroll, Bluetooth polling, per-OS scaling, rotary encoder, live sensor image |
| Effects | Global lighting and battery warnings, plus per-event colour including each Bluetooth profile |
| Import/Export | Settings as .json, plus full device backup, restore and erase |
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
| `src/Control.jsx` | picks the shape for one setting: dial, slider, field or switch |
| `src/Dial.jsx` | the radial knob |
| `src/Curves.jsx` | acceleration curve editor and its SVG chart |
| `src/Effects.jsx` | per-event RGB / vibration editor |
| `src/Board.jsx` | keymap profiles, import/export, storage backup, surface quality |
| `src/Heatmap.jsx` | the live sensor image |
| `src/Logs.jsx` | the console tab |
| `src/Status.jsx` | header readout: active output, firmware, battery |
| `src/Trackball.jsx` | the three.js preview — the real device, built procedurally |
| `reference/trackball3d.html` | standalone model the preview was ported from |
| `reference/marshmellow-ui.html` | later build of the original app; the protocol reference |
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

Sensor surface quality is out of whatever the sensor reports — 361 on one
part, 1000 on another — so the good/warning/bad bands scale with it. One
exception is a firmware quirk carried over from the previous UI: a reported
maximum of **728 means 1000**, so it is substituted at parse time. The raw
figure is kept as `reportedMax` and shown in the gauge's tooltip.

Battery is read verbatim from `board status` with no scaling, exactly as the
previous UI did — whatever percentage appears is the number the board gave.

## The preview

The preview is the device, not a stand-in sphere: rounded-square shell, eight
radial keys, the ball in its socket, the USB-C port and both corner encoder
wheels, all built procedurally from `trackball3d.html`'s geometry constants so
the proportions match the hardware.

You can handle it the way the standalone model does:

- **Drag the ball** to roll it, with inertia. This is the settings preview —
  sensitivity changes its weight, the dead zone flares the socket ring when it
  swallows a movement, smoothing lengthens the coast.
- **Drag the body** to turn the device through 360 degrees, **scroll or pinch**
  to zoom.
- **Click a key** to press it, **click a wheel** to spin it. Twist-scroll spins
  them too.
- **Reset / Top / Port / Wheels** jump to framed views; **Flick** spins the ball.
- **Colours** recolours the body, ball, wheels and each of the eight keys. The
  choice is remembered in `localStorage`.
- Keyboard: arrows roll, shift with arrows turns, `+`/`-` zoom.
- A **pointer output** pad, bottom left, shows where the pointer would travel
  for the roll you just made at your current sensitivity, plus ball speed in
  rpm. A spun wheel registers on it as scroll. Desktop only — the phone
  viewport is ~32dvh and the model needs that frame.

Per-frame values (the pad's dot and rpm) are written straight to the DOM in the
render loop. Routing them through React state would re-render the settings
panel on every frame.

The camera fits the model's real bounding-box corners at the current orbit
angle, so it fills a phone strip and a desktop panel equally well.

Two things keep it cheap: the shadow pass runs once and is then frozen (only
the ball and wheels move, and both are surfaces of revolution turning about
their own axis, so their shadows never change), and the loop is capped at 30fps
and pauses when the page is hidden or the canvas is scrolled out of view.

## Choosing a control's shape

A page of forty sliders reads as a spreadsheet and a page of forty dials reads
as a cockpit, so `src/Control.jsx` picks by what the setting is like:

- `hero: true` gets a **dial** — the five settings you reach for to change how
  the device feels (sensitivity, rotation, smoothing, scroll speed, brightness).
  Deliberately a short list; a dial earns its space by being rare.
- Everything else visible gets a **typed number box over a slider**, with its
  two bounds printed underneath, so the range is readable without dragging.
- Anything under Advanced gets a **number field** in a two-column grid, because
  there an exact value matters more than a sweep.
- Anything with a 0-1 range is a **switch**, decided from the device's own range.

Dials are gathered into a row, but only when they are *adjacent* in the
catalogue. Floating every dial to the top of its card put the scroll-speed dial
above the switch that enables twist scrolling at all.

Word units carry a leading space in the catalogue (`" frames"`, `" ms"`) and
symbols do not (`"x"`, `"°"`). The scale under a slider uses that to print
`1 … 16 frames` rather than `1 frames … 16 frames`.

Each group is a card, and only what people actually reach for is on it — three
or four rows. The rest sits behind **Advanced**, where every control names a
sub-group (`adv:`), so a run of twenty rows renders as a handful of short titled
ones rather than one flat list. Both halves of that matter: the original app
shows three pointer settings and hides thirteen, and the wall of knobs is what
made this tab hard to read.

A key the catalogue has no entry for is still shown, built from the device's own
`rtcfg list` under the owning section's `prefixes`. Two things follow that are
easy to get wrong:

- Their **id is the rtcfg key itself**, and they are built inside `KnobSection`,
  so they are not in `allControls`. `seed()` therefore starts from the rtcfg
  listing, and `save()` falls back to `rtcfg set <key>` for ids the catalogue
  does not own. Skip either and they render as their slider minimum and drop
  edits without saying so.
- A **three-segment key names its own group in the middle**, so the twelve
  `bst/<profile>/s0_mult`-style keys land in Snipe, Twist and Dragscroll blocks
  without any of those names appearing in our source. Whatever profiles a
  firmware defines are what you get.

Sensor surface quality is the first card on the Sensor(s) tab. It reads
continuously while that tab is open, so you can roll the ball and watch it
move; between reads the last value stays on screen.

## Layout and alignment

The panel takes a straight 33% share of the stage (`minmax(360px, 33%)`). It
was capped at 27rem, which read as 65/35 at 1280 but degraded to 77/23 by 1920
and worse on anything wider; a share holds at 31-32% from 1280 through 2560.

Two rules keep controls on a grid rather than merely near one:

- one `--field-h` for everything you type into or pick from, so a number field,
  a select and a switch share a row rhythm;
- a reserved `--unit-slot` after every number field, whether or not it has a
  unit — and the same gutter on toggles, since otherwise a switch sits a slot
  further right than every box beside it.

Widths that matter are asked of the container, not the viewport: the advanced
grid goes two-column via `@container panel (min-width: 400px)`, because the
panel is a fixed side column whose width has nothing to do with the window's.

## Nothing is silently hidden

A curated control is hidden when the firmware does not report its key. On its
own that means a *renamed* key just disappears — which is how the brightness
control and the `twist_dy_mag` pair went missing on real boards. Each section
therefore claims key prefixes (`argb/`, `p2sm/`, `ec11/`, ...) and any key
under them that no curated control covers is added automatically, auto-labelled
from the key name. A section shows everything the firmware has under it.

Readings are auditable rather than asserted: the battery gauge's tooltip
carries the raw `board status` reply it was parsed from, and if
`sensor surface` answers in a wording the parser does not recognise, the card
prints the raw text instead of rendering an empty gauge.

## Live vs demo

`live` means "a device is attached", not "no command is in flight". Deriving it
from a busy flag meant every save briefly flipped the whole UI into demo mode —
panels swapped in sample data and the status bar showed a placeholder battery
level on a genuinely connected board. Busy-ness is a separate `busy` flag that
only disables controls.

Demo mode never invents a reading: the battery gauge shows `--` and no firmware
version, rather than a plausible-looking number.

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

## Connecting

The shell is not ready the moment the transport opens, and sending to it too
early gets no reply at all — the symptom is `Timed out: rtcfg list` on the very
first read. So `device.js` runs the previous UI's handshake on connect:

1. settle — 2000 ms on USB, 1500 ms on BLE;
2. probe — send `__init` until the reply contains `command not found`, which is
   how a live shell answers a command it does not have. Retries every 500 ms up
   to 25 s, each probe capped at 3 s so a dead link fails fast;
3. `shell echo off`, so replies are not polluted by the echoed command.

Only then does `readAll()` run. A dropped BLE link is caught via
`gattserverdisconnected` rather than leaving the app believing it is connected.

**A reply ends at a prompt, or at silence.** Not every firmware and transport
prints a prompt we recognise, and waiting only for one is what made Bluetooth
fail: `awaitPrompt` threw while the answer was sitting in the buffer. It now
also accepts "bytes arrived, then stopped for `QUIET_MS`" as a finished reply,
and returns a partial rather than throwing when the deadline passes with
something in hand. Only total silence is an error. The handshake is likewise
satisfied by any reply, not just the exact "command not found" wording.

**Bluetooth needs both characteristics and a write it can actually use.** The
service carries a shell characteristic (`c901c4ea`) and a data channel
(`c901c4eb`); both reference builds subscribe to both before saying a word, so
this does too — some firmware will not start talking until both subscriptions
exist. Writes prefer `writeValueWithoutResponse` and fall back to a plain
`writeValue` if the characteristic does not offer it, remembering which worked.

**The connection log is on the connect screen.** It used to live only in the
Logs tab, which is behind a successful connect — so the one time you most need
it, a failure, was the one time you could not reach it. The welcome screen now
shows the same rows, open by default while idle. The BLE path narrates itself
into it: which device was selected, GATT connected, the characteristics found,
what the shell characteristic supports (notify / write / writeWithoutResponse),
each subscription, and the settle wait. Where the list stops is the fault.

**Handshake failures name their cause.** Probe errors used to be swallowed, so
a write that threw on every attempt looked identical to a silent device. They
are logged to the Logs tab now and the final message carries the last real
error, not just "did not respond".

**If Bluetooth connects but nothing ever comes back, it is a stale pairing.**
Observed once and worth writing down: GATT connected, both characteristics were
found with the right properties, both subscribed, and every write returned
without error — yet not one byte ever arrived, from either a dev server or the
built file.

The shell characteristic offers only `writeWithoutResponse`, which is
unacknowledged: a write "succeeding" means Chrome queued it, not that the
device took it. A half-established link drops those silently and never enables
the CCCD, so notifications never fire either — one cause, both symptoms, and no
error anywhere to point at it.

The fix was to clear the trackball's saved Bluetooth profiles and toggle
Bluetooth off and on on the host, then pair again. It then worked from both
origins, so this is not about where the page is served from.

**A failed connect tears the transport down.** `connectUSB`/`connectBLE` call
`disconnect()` first and again if the handshake fails. Without that, a failed
BLE attempt left `this.shell` set, and since `send()` chose its transport by
that field, subsequent USB commands were written into the dead BLE
characteristic — USB then worked only after a page refresh. `send()` also
routes on `this.kind` now rather than on a field that can go stale.

## Talking to the device

The firmware exposes a text shell. Connections are USB serial (vendor `0x11`,
product `0x07`, 460800 baud) or BLE (service `c901c4e9-...`). Commands are lines
like `rtcfg set p2sm/twist_thres 40`; responses end at the shell prompt
(`endgame$`, `uart:~$`, `zmk$`, `zmk:~$`).

The one exchange that is not request/response is the sensor image:
`sensor stream --on` pushes frames until you stop it. Those arrive through
`device.onRaw` rather than `device.send`, and `device.streaming` tells the
background pollers to stand down while it runs — a `board output` reply landing
in the middle of a frame corrupts it.

Details worth keeping, all covered by `node src/protocol.js`:

- `rtcfg list` prints `<key>  <value>  (default: <n>)` and keys may have three
  segments (`bst/<name>/s0_div`) — a parser anchored at end of line returns
  nothing at all.
- **`rrl set` takes milliseconds, not hertz.** It is the axis sync window,
  0–10, where 0 means no limit and 1 ms is 1000 Hz. Reading `rrl get` back as a
  rate and writing it again sets a window a hundred times too long.
- **`p2sm sma on|off` is separate from `p2sm sma window set N`.** Sizing the
  smoothing filter while it is switched off changes nothing. `p2sm status`
  reports `SMA smoothing: enabled|disabled` alongside `SMA window: N`.
- **`bistable set N` changes the slot in use now; `bst/default` is only what the
  board boots into.** Read the first with `bistable slot`. They are easy to
  confuse and a control that reads one and writes the other looks broken.
- Replies to `p2sm ...` contain the word **p2sm**, whose `2` is the first digit
  in the string. Strip it before matching numbers or a 2.5x reading comes back
  as 0.2x.
- Curve segments are eight integers scaled by 100 in the order
  **start, end, cp1, cp2** — the end point comes before the control points.
- `board backup` frames the partition as `BACKUP START <startHex> <sizeHex>`,
  lines of `<offsetHex>:<dataHex>#<crc8>`, then `BACKUP END`. The checksum is
  **CRC-8, polynomial 0x07, MSB-first**, no init or final XOR. Restore replays
  the same lines back, one per `board restore` command.
- `sensor stream --on` emits `F <id> <seqHex>`, then hex rows one byte per
  pixel, then `END`. Lines split across chunk boundaries, so the reader has to
  hold a partial line between them.
- Only `layer` events support solid/blink/breathe; every other RGB event is
  flash-only.
- Commands go to USB one word at a time, because the device's line editor drops
  bytes when a long command arrives in a single burst; there is also a 200 ms
  floor between commands. Neither is stylistic.

Requires a Chromium-based browser for Web Serial / Web Bluetooth. Without
either, the app still opens in demo mode.

## Original vs this app

`reference/marshmellow-ui.html` is the app this replaces, kept in the tree as
the protocol reference. **Every shell command it sends, this app sends**, with
the same spelling and the same argument units. There is no feature of the
original that is missing here.

### Feature by feature

| Capability | Original | Here |
| --- | --- | --- |
| Runtime parameters (`rtcfg`) | Curated screens only | Curated **plus** every key the board reports, and a searchable Raw tab |
| Unknown or renamed keys | Vanish | Still shown, filled in from `rtcfg list` under the owning section |
| Acceleration curves | Bezier editor | Same |
| Keymap profiles, assignment, autoswitch | Yes | Same |
| Per-OS scaling (`bst/…`) | 3 fixed cards: Snipe, Twist, Dragscroll | Grouped from the device's own listing, so *whatever* profiles a firmware defines appear |
| Per-event RGB / vibration | Yes | Same, plus a colour swatch per Bluetooth profile |
| Layer names on RGB events | By array position | By the number the board reports |
| Storage backup / restore | Yes | Yes — see below |
| Factory erase | One click | Behind typing `ERASE`, and names what it destroys |
| Live sensor image | Fixed auto-contrast | Auto contrast is a switch; caption reports size, fps and range |
| Settings as `.json` | — | Export, import, edit or paste |
| Log console | — | SEND/RECEIVE with timestamps, download, and a command prompt |
| 3D device preview | — | The real model: orbit, zoom, clickable keys, live pointer output |
| Demo mode without hardware | — | Every tab, including a synthetic sensor image |
| Offline | Yes | Single self-contained HTML file |

### Where we are deliberately stricter

These are behaviour differences, not extra features, and each one is a bug in
the original that we do not reproduce:

- **The backup `.dat` image actually downloads.** The original builds the
  anchor, appends it, and removes it again *without ever clicking it*, so only
  the `.bak` is ever saved.
- **The image is sized from the declared size and the furthest offset seen.**
  The original allocates a fixed 32768 bytes and drops anything past it with no
  error.
- **A restore file is checksum-verified before a single byte reaches flash**,
  and the write button does not appear until it passes. The original checks
  only that each line *looks* like a line, then starts writing to flash.
- **A stopped restore says the partition is half-written.** The original just
  stops.
- **`Unlock ZMK Studio` is detected in all three wordings.** The firmware says
  "…first" for keymap writes but "…to allow backup" and "…to allow restoration"
  for storage ones, so matching only the first reads a refusal as a normal
  reply.
- **Layer names are keyed by the reported number.** The original pushes them
  into an array in encounter order, so a board that skips a layer number shifts
  every later name onto the wrong layer.

### Not built

Nothing from the original. The one thing neither app has is per-encoder-ID
behaviour screens (step, min/max step, wrap, feedback pattern); those keys are
editable under Raw settings, just without a dedicated editor.
