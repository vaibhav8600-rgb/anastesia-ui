# Anastasia-UI

Web-based configuration interface for ZMK trackballs / mice.

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

Eight tabs. Seven match the original's shape; Firmware is ours.

| Tab | What it covers |
| --- | --- |
| Keymap | A live key binding editor over ZMK Studio's RPC, plus profile slots, per-connection assignment, autoswitch, Windows/macOS mode |
| Acceleration | Curve editor — a draggable Bezier graph per device, log scales, import/export |
| Sensor(s) | Surface quality with a trend strip, pointer feel, twist scroll, Bluetooth polling, per-OS scaling, rotary encoder, roll-quality map, live sensor image |
| Effects | Global lighting and battery warnings, plus per-event colour including each Bluetooth profile |
| Import/Export | Settings as .json, plus full device backup, restore and erase |
| Firmware | What the board runs against what your config repo has released, which .uf2 belongs to your sensor, and a guided write to the bootloader |
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
| `src/Studio.jsx` | the key binding editor: layers, key positions, the picker |
| `src/studio.js` | ZMK Studio's RPC — framing, protobuf and the message set, with a runnable self-check |
| `src/keycodes.js` | HID usages and mouse masks, so a binding reads as a key |
| `src/Firmware.jsx` | release check, the right .uf2 for this board, and the bootloader write |
| `src/ripple.js` | the droplet on press: one delegated listener, no per-button handlers |
| `src/Heatmap.jsx` | the live sensor image |
| `src/RollMap.jsx` | tracking quality by roll direction and speed |
| `src/Loading.jsx` | the one spinner, shared by every panel that waits |
| `src/Theme.jsx` | the glass/flat switch and where the choice is kept |
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
angle, so it fills a phone strip and a desktop panel equally well. A bounding
box centre is not an *optical* centre, though: aiming at it left the device
sitting low with 187px of air above and 41 below at 1280, and the imbalance
grew with the viewport — 263 against 46 at 1920. After the fit, the silhouette
is projected and the camera panned in view space until its middle is the
frame's. Two passes converge, and the ratio then holds at any aspect: 133/104
at 1280, 182/141 at 1920. The residual air above is a deliberate 0.04 NDC
bias — optical centre reads slightly high, and the contact shadow occupies the
space below.

Lighting is a **ratio**, not a flood. Ambient at 0.9 reached every face of the
shell equally, which is the one thing a white object cannot survive: 54.8% of
its pixels sat above 200 and the body read as a cut-out rather than a moulded
shape. Ambient is 0.10 now and the job it was doing badly — keeping the unlit
side off black — belongs to a directional fill opposite the key, which shades
across a surface instead of flooding it. Near-white fell to 28.5%, and the
shell's tonal spread *widened* from 40 to 51 while its mean moved only 204 to
186, which is the check that this is form rather than dimming.

The shadow frustum was 26 units across for a device 9 wide, so most of the map
landed on empty floor and what arrived was a grey smear. Tightened to the
device plus its throw with four times the texels, it reads as contact.

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

Each row says its verdict in words — **good / fair / poor** — and prints the
reading that decides it ("good from 500"). `qualityBand()` had been computing
the band and then throwing it away, passing only a CSS class, which left a bar
colour carrying the whole message. The word is a bordered tag on the micro
step rather than tinted text: beside a full-width bright bar, a coloured word
reads as decoration. The threshold is per row, not per card, because the
cut-off is a fraction of each sensor's own scale (0.25/0.5 on a 1000 scale,
0.3/0.6 on 361) and two sensors can report different scales. `goodAt()` and
`qualityBand()` come off the same lookup, so what is shown and what is applied
cannot drift.

The trend line under the bar is on the UI accent, not on the band colour it
used to repeat. Trend and verdict are different questions, and a second copy
of one cue is not a second cue.

### Roll quality

`src/RollMap.jsx` bins SQUAL by **how the ball is moving** — direction around a
polar chart, speed outward — one chart per sensor.

It is deliberately *not* a map of the ball's surface, and the distinction is
the whole design. Colouring a patch of the ball means knowing which patch is
under the sensor, which needs rotation integrated from a known origin and
wrapped at the ball's circumference. Neither is observable: the only motion we
can see is the pointer the ball drives, and that has been through the
firmware's sensitivity, its acceleration curve and then the OS's own pointer
acceleration — nonlinear — while the circumference in pointer counts is
unknown. Wrap at the wrong modulus and the same physical patch lands in a
different cell every revolution: the map smears into noise *while still looking
like a map*, which is worse than not drawing one.

Direction and speed do survive that chain, and they answer the questions people
actually have — does tracking fall off when I roll fast, is one direction worse
than the others. Readings taken while the ball is still are dropped, since a
resting value would drag every cell toward it.

It reads the same `sensor surface` replies the gauge already asks for rather
than polling a second time, and asks for a faster cadence only while it is
collecting.

Under each gauge is a **trend of the last 60 readings**. SQUAL is a single
scalar — a count of trackable features — so it cannot make an image no matter
what is done to it; what it can show is its own shape over time, and a dropout
while you roll is exactly what one live number hides. The strip is scaled to
its own window rather than to 0-max, because a good surface sits around 700±40
and against a 1000 axis that is a flat line. That makes the vertical scale
data-dependent, so the window's range is printed beside it; below a 2% spread
it reads "steady" and draws flat rather than amplifying noise into a mountain.

## The design system: glass over a wash, lit from the top-left

Two systems, kept separate in `src/styles.css` so they cannot fight:

**Glass** is for anything that *floats* — the two stage panels, the header
chips, the popovers. A translucent fill, a bright hairline edge, and a blur of
what is behind it. The page itself is a fixed wash, which is the thing the
glass has to be glass *of*; the 3D canvas is `alpha: true`, so the wash shows
through behind the model too.

The wash is four saturated blooms over a **dark** base gradient, and the base
is what matters. An earlier version used a light base (`#3f4569` is luma 70),
which capped the floor no matter what the blooms did: the darkest pixel on the
page was luma 77 and saturation had drained to 0.23, so nothing read as dark
and the whole field sat above mid-grey. With `#1b1836` at the bottom the range
is 28–114 at 0.35 saturation — the same lit core, with somewhere to fall away
at the corners.

Darkening uniformly is the tempting move and it is wrong. Separation across a
panel edge is `alpha x (ground - fill)`, and every fill is darker than the
ground, so a dimmer ground shrinks every edge: a vignette measured floor 23
but dropped the settings panel edge from 2.09:1 to 1.52:1.

Panels **smoke** rather than lighten: a dark translucent fill over a lit ground.
Lightening them on a dark ground was tried first and produced grey slabs — the
sense of glass comes from the ground being brighter than the pane.

Glass comes in **three elevation tiers**, distinguished by how much ground they
let through, how hard the edge catches light, and how far they sit off the
surface below. Tier 1 is the two stage panels (fill 0.41), tier 2 the cards
inside them (0.20, deliberately *without* blur — it sits on an already-blurred
backdrop, so a second full-screen pass would buy nothing), tier 3 the things
floating over the model: the caption, the pointer pad, the palette and the
viewport's tool buttons.

The viewport is the exception that proves the rule. Its job is to show the
scene, so its fill stays at 0.13 and cannot separate it from the ground the way
tier 1 does. It buys its edge from the **edge** instead — a bright bevel inside
a dark ring, which is how a real pane reads against a lit background and costs
no opacity. Measured against the ground it carries 2.71:1 and 1.92:1, ahead of
the settings panel's own 1.80:1.

**Neumorphism** is for anything you *touch* — buttons, switches, sliders,
fields. One light source, top-left, for all of them: raised things take a pale
highlight up-left and a soft shadow down-right, sunken things take exactly the
reverse, and pressing a button swaps its raise for the matching well. Mixing
the direction per element is what makes this style look cheap.

Two costs are deliberately not paid:

- **Cards do not blur.** Nesting `backdrop-filter` inside an already-blurred
  panel buys nothing — there is nothing between an inner card and its parent to
  blur — and costs a second full-screen pass.
- **The viewport buttons do not blur either.** Six of them sit on top of a
  canvas that redraws at 30fps, so each would force a re-composite every frame.
  They are tier 3 in every other respect. Tier 3 therefore has two expressions:
  the palette blurs its backdrop, the three overlay elements do not. That is a
  known seam, not an oversight.

Light mode is not the dark palette with swapped text. It gets its own wash on a
near-white base, and the two neumorphic shadows change meaning: the highlight
becomes near-white and the shadow a soft violet-grey, which is what stops the
style turning into grey mud on a pale ground.

### Motion

Two things move, both specular, so they read as one material:

- a **sheen** slides across a button on hover, opacity and transform only —
  never the blur radius, which cannot be animated cheaply;
- a **droplet** spreads from where you pressed. `src/ripple.js` is one
  delegated `pointerdown` listener that writes the pointer position into two
  custom properties and flips an attribute; the animation itself is CSS, so
  nothing runs per frame. Position is why it is not pure CSS — a `:active`
  ripple can only grow from the centre, and on a tab as wide as
  "Import/Export" that is visibly not where you clicked. A keyboard press has
  no pointer, and falls back to the centre.

Both are glass-only. Flat had no specular anything, and a highlight spreading
across a solid fill would be the one glass trait it inherited. Both are also
decoration, so `prefers-reduced-motion: reduce` removes them outright rather
than shortening them.

### Type: four steps

Twenty-seven distinct size/weight/tracking combinations rendered on a single
tab, including a card title at 16.8/650 against a control label at 15.0/500 —
a difference you have to measure rather than see — and 13.6, 13.9, 14.1 and
14.4 doing one job with four values.

| token | size | weight | used for |
| --- | --- | --- | --- |
| `--fs-title` | 16.8px | 700 | card and section titles |
| `--fs-label` | 14.0px | 550 | control labels, buttons, tabs, summaries |
| `--fs-body` | 12.8px | 400 | prose, hints, values, units, captions |
| `--fs-micro` | 11.2px | 700 caps | eyebrows and tags, one tracking |

Every step differs in **both** size and weight, so the hierarchy survives a
squint. Buttons all sit on the label step, which is why the viewport's tool
buttons are not micro: micro means capitals, without exception, so the step is
identifiable by shape alone.

Four sizes remain outside the scale — dial numerals, dial units and rose ticks.
They are drawn in user units inside an SVG `viewBox` and scale with the
graphic, not the page.

### Spacing: a 4px grid

Twenty-five distinct spacing values, most a pixel or two apart — 0.3 and 0.35
rem, 0.55 and 0.6, and one card padding declaration holding 1.15, 1.25 and 1.35
at once. Every padding, margin and gap now snaps to a multiple of 4px, which
leaves seven — 4, 8, 12, 16, 20, 24 and 40 — plus zero and two negatives. Card
padding is one token, `--card-pad`.

### Colour: every ink has a text-safe sibling

The accent is violet and stays violet, and the reason is measurable rather than
aesthetic. The model's coral `#ef6b6b` is fixed hardware identity, and it sits
**19 dE and 19 degrees of hue** from `--danger` — promoting it to the UI accent
would make "this is interactive" and "this will destroy something" the same
signal on the same panel. Violet's nearest semantic neighbour is 56 dE away.
Coral also measures 3.23:1 on tier 1 and cannot be rescued by lightening,
which moves it toward pink and so toward danger.

Any colour used as **text** has a `-text` sibling defined where the colour is
defined, sized to clear 4.7:1 on tier 1 at the brightest ground it covers:

| ink | on tier 1 | |
| --- | --- | --- |
| `--text` `#ece9fb` | 8.14 | |
| `--ok-text` | 6.82 | aliases `--ok` |
| `--accent-text` `#cbbcff` | 5.63 | `--accent` itself is 4.54 |
| `--muted` `#c9c4e2` | 5.77 | |
| `--warn-text` | 5.54 | aliases `--warn` |
| `--danger-text` `#ffa3b9` | 5.17 | `--danger` itself is 4.00 |
| `--muted-dim` | 4.72 | replaces three hand-dimmed fades |

The two that pass unchanged are aliased anyway, because the point is the
reflex: nobody should have to remember which three of five needed it. `--accent`
and `--danger` keep their original values as fills, borders and tracks, where
the 4.5:1 text rule does not apply.

Contrast is audited by **enumerating every rendered ink** — walking the DOM for
elements that render their own text and tallying size, weight and computed
colour — rather than by checking the token list. Token-level auditing is what
let three `color-mix` fades sit under 4.5:1 unnoticed.

### Both themes are switchable

The flat design this wore before the glass pass is still here, on a **Glass /
Flat** button in the header and on the connect screen. The choice is kept in
`localStorage`.

The switch sets one attribute, `data-theme` on `<html>`. It works because every
glass and neumorphic trait goes through a token, so `:root[data-theme="flat"]`
only has to redefine variables — no component knows which theme is on, and no
rule is duplicated. The four shadow tokens resolving to `none` is what actually
flattens it: every rule still asks for them.

Adding a theme is therefore a token block, not a second stylesheet. The traits
worth knowing are the non-obvious ones: `--glass-filter` (the `backdrop-filter`
value, `none` when flat), `--knob-radius` (round knobs are a neumorphic trait),
`--dial-cap` and `--dial-glow`, and `--bar-rule` / `--tabs-rule`, since the flat
build separated regions with hairlines where the glass one uses depth.

## Layout and alignment

The panel takes a 40% share of the stage, `clamp(360px, 40%, 1000px)`: 59/41
at 1280, 60/40 from 1920 to 2560, 70/30 at 3440. The small drift below 1920 is
the gap between the two panels, which belongs to neither.

It was once capped at 27rem, which read as 65/35 at 1280 but degraded to 77/23
by 1920 and worse on anything wider. A percentage holds its ratio at any width;
a fixed cap cannot. The 360px floor keeps the panel usable at the 900px
breakpoint, where 40% would be too narrow for a label and a field side by side.
The 1000px ceiling only bites past 2500 and stops an ultrawide handing a third
of the desk to a settings column.

A 600px measure inside the panel was tried and removed. It kept toggles near
their labels but left a dead column on the right at every width above 1600 —
142px at 1920, 400 at 2560 — and capping the panel to match cost the ratio
instead (74/26 at 2560). Cards fill the panel; the panel's own ceiling is the
measure. The alternative that pays neither price is a two-column card layout,
which only one tab has the cards to use and which would split the Effects tab's
`.sec` heading from the content it introduces.

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

## Waiting is a normal state

Every tab talks to the shell when it mounts, behind a 200 ms floor between
commands, so "waiting" happens constantly rather than exceptionally. A panel
that renders its headings over empty lists while it waits looks like a panel
whose board reported nothing, which is why `src/Loading.jsx` exists and why
Keymap, Acceleration, Effects, surface quality, the stream probe and the
connect screen all use it instead of bare text or nothing at all.

**Demo mode waits too, on purpose.** It used to answer instantly, which no
device does, and the effect was that nothing ever rendered a loading state —
so nothing exercised one, and a broken indicator could not have been noticed
without hardware. Demo now takes `DEMO_LATENCY_MS` (450 ms, conservative
against a real multi-command read) before answering. This is the same lesson as
the sensor stream, where a demo path that skipped the real plumbing hid a
missing method until it reached a device.

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
`board status`.

Two different facts sit next to each other there, and they are labelled so they
cannot be confused: the **icons** are where the board sends the pointer, the
text reads "**via USB**" or "**via BLE**" and is the link this app is
configuring over. They genuinely differ — on Bluetooth with a cable in for
power, a lit USB icon is correct.

Which transport is open comes from App rather than from `device.kind`.
`device.kind` holds the same fact but is a mutable singleton, so nothing
re-renders when it changes and the header kept naming the previous session's
link for as long as it took the next 3-second poll to land. The poll stays as
the correction that catches a link dropping underneath us, which a prop cannot
see. Output is polled every 3 s and status every 5 min, and both
stand down whenever one of your own commands is queued or the sensor stream is
running, so a poll never makes you wait and never lands inside a frame.

## Keeping it quick

Two things dominated first-paint, and both are fixed:

- Effects used to read every event up front — around twenty round trips behind
  a 200 ms inter-command floor before the tab drew anything. It now reads the
  event list, the layer names and whether RGB is supported — three calls — and
  fetches each event's detail on selection, caching as it goes.
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
   how a live shell answers a command it does not have. Retries every 300 ms up
   to 25 s, each probe capped at 2.5 s so a dead link fails fast;
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
  hold a partial line between them. **The `id` is the sensor**, and a trackball
  has two: painting every frame onto one canvas makes them fight over it, so
  there is a canvas per id, created when that id first appears.
- **Not every firmware has the command** — v101.4.4 does not. It needs a driver
  built with frame capture, and *which* driver depends on the sensor the board
  carries: for a pmw3610 that is the `z4.1/feat/frame-grab` branch, a paw3395
  is a different driver again, and some expose no frame capture at all. The
  shell prompt must also be one of `zmk$`, `zmk:~$` or `uart:~$`. A board
  without the subcommand answers with the *parent* command's help
  (`sensor - Sensor Diagnostics`, then `Subcommands:`), never an error, so
  "a reply arrived" is not "it worked". The panel therefore names no driver;
  it prints the subcommands the board itself listed.
- While the stream runs, its bytes must **bypass** the command buffer rather
  than being copied into it as well. `awaitPrompt` re-scans that buffer every
  20 ms and nothing clears it mid-stream, so duplicating left it scanning
  hundreds of kilobytes fifty times a second — a blank canvas and a wedged
  page. `Device.ingest()` is the single place that decides.
- Only `layer` events support solid/blink/breathe; every other RGB event is
  flash-only.
- Commands go to USB one word at a time, because the device's line editor drops
  bytes when a long command arrives in a single burst; there is also a 200 ms
  floor between commands. Neither is stylistic.

Requires a Chromium-based browser for Web Serial / Web Bluetooth. Without
either, the app still opens in demo mode.

The USB chooser filters on vendor `0x11`, which hides a board flashed with a
driver branch that enumerates under another id. **Not listed? Show every serial
port** on the connect screen drops the filter — the original calls the same
thing "show only supported devices".

## Firmware

The Firmware tab reads the board's version and its sensor variant — the
firmware encodes the sensor in the major, so 101.4.4 is 1.4.4 on a PAW3395 —
then asks a GitHub repo for its latest release and names the one `.uf2` that
belongs to this board. It points at `efogtech/endgame-trackball-config` by
default, which is where the firmware people actually run comes from; the field
is editable for anyone building their own. Picking the wrong one of the two a release ships is the
actual failure mode, and the board is the only thing that knows which is yours.

The download is a link rather than a fetch, and the reason is in the file so
nobody tries to "fix" it: release assets redirect to
`release-assets.githubusercontent.com`, which sends no
`Access-Control-Allow-Origin`, and every response in a redirect chain has to
pass. A proxy would mean a server, would break the single-file offline build,
and would route firmware through a third party.

Everything around the download is automated. The write goes through the File
System Access API with two guards, because a bootloader takes whatever it is
handed: the chosen directory must contain `INFO_UF2.TXT`, and the file must
carry all three UF2 magic words and be a whole number of 512-byte blocks. A
variant mismatch warns rather than blocks — it is recoverable, and saying so is
more use than refusing.

## The keymap editor

Key bindings are not in this firmware's shell. `zmk-keymap-shell` registers
init, status, save, overwrite, activate, destroy, restore, free and assign, and
every one of them works on a whole keymap slot; `output_keymap.c` turns out to
be endpoint-to-slot assignment rather than a binding dump. Bindings live behind
ZMK Studio's RPC, so `src/studio.js` speaks it.

It is smaller than it sounds. The framing is three bytes and an escape rule
(`zmk/app/src/studio/msg_framing.h`), and the schema is five `.proto` files
totalling 8KB, pinned by ZMK v0.3.0 at `zmk-studio-messages` 6cb4c28. Proto3 on
that message set needs only varints, length-delimited fields and zigzag — no
fixed32, no fixed64, no maps — so the codec is about a hundred lines and the
messages are data tables declared in upstream's order. No generator, no
dependency, no build step. Twenty-six assertions run without a board.

The editor takes its own port, because the RPC is a second CDC-ACM interface on
the same USB device. Both interfaces share a vendor and product id, so
`requestPort()` filters cannot separate them, and which port numbers or paths
they get is up to the machine — it differs between computers and between
boards. So the editor asks rather than assumes: it opens each granted port and
keeps whichever answers `get_device_info`. A port the settings tabs are holding
fails to open and is skipped, which is the right answer, since that one is the
shell by definition.

## A reply is not finished just because the board went quiet

`awaitPrompt` ends a reply on a known prompt, or on the device having stopped
talking for `QUIET_MS`. That second rule needs the buffer to hold actual
content, not whitespace, and the difference is not academic: `keymap status`
reads every slot out of flash before it prints anything, the shell emits a bare
newline first, and the read takes about 1.2 seconds. A buffer holding only that
newline, quiet for longer than the threshold, was being called a finished and
empty reply — so the listing arrived after we had stopped listening, and a
board with saved profiles reported none.

Any command that thinks before it speaks would have hit this. The rule is now
that a reply is complete when a prompt is seen, or when there is non-whitespace
content that has gone quiet.

## Profiles need starting before they can be listed

`keymap status` answers with nothing at all on a board whose slots subsystem
has not been initialised, while `keymap assign` on the same board will happily
name the profile assigned to USB. Empty is therefore not "this firmware has no
profiles" — it is "not started yet", and the shell registers `init` for exactly
that. An empty reply runs `keymap init` once and asks again; only a
`command not found` means the feature is genuinely absent. Reading the two as
the same thing is what made a board with a saved profile report none.

Three things about reading a binding are worth knowing, because each was a bug
first:

- **Implicit modifiers ride in the top byte.** A usage is
  `(mods << 24) | (page << 16) | id`, so Ctrl+C is `0x01070006`. Reading the
  page as sixteen bits swallows the modifier and prints "107:6".
- **Mouse buttons are not HID usages.** ZMK's `dt-bindings/zmk/mouse.h` makes
  them bitmasks — MB1 is 1, MB2 is 2, MB3 is 4 — which collides with the
  keyboard page, where a bare 4 is the letter A. The behavior decides which
  namespace a value is in.
- **Each parameter answers for itself.** "Hold/tap (layer/mouse key)" takes a
  layer first and a button second; deciding from the behavior's name made the
  layer read as a mouse button and print "Layer: Right Click".

The picker is built from the board's own metadata: a parameter that declares a
layer gets this keymap's layers by name, one that declares a fixed set gets
those names, one that declares a usage gets the grouped list of 172. Labels
come from the metadata too — except for a fixed set, where the names are the
values (MB1, MB5) and not a name for the parameter.

Bindings are drawn on the 3D model as well. Neither side is told the other's
indices: both sort their keys by angle around the centre, which is a property
of the board rather than of two build orders. Encoders are dropped from that
ring — the model has wheels there, not keys — and are labelled on the shell
beside each wheel, on a face that hides itself when you look down at the board.

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
| **Key bindings** | Links out to ZMK Studio | Edited here. The RPC is spoken directly: layers, key positions drawn from the board's own physical layout, a behavior picker driven by each parameter's declared type, save and discard |
| Firmware updates | Notifies, links to the releases page | Same check, plus it names the one `.uf2` that matches your sensor and writes it to the bootloader for you |
| Per-OS scaling (`bst/…`) | 3 fixed cards: Snipe, Twist, Dragscroll | Grouped from the device's own listing, so *whatever* profiles a firmware defines appear |
| Per-event RGB / vibration | Yes | Same, plus a colour swatch per Bluetooth profile |
| Layer names on RGB events | By array position | By the number the board reports |
| Storage backup / restore | Yes | Yes — see below |
| Factory erase | One click | Behind typing `ERASE`, and names what it destroys |
| Surface quality (SQUAL) | Live number and bar | Same, plus a 60-reading trend strip per sensor |
| Roll-quality map | — | Quality binned by roll direction and speed, per sensor |
| Live sensor image | One panel per sensor, 4 ramps, auto gain, blur; hidden if unsupported | Same, plus per-sensor seq/range/size/fps, Esc or Space to stop, and when unsupported it says so and names the subcommands the board *does* have |
| Settings as `.json` | — | Export, import, edit or paste |
| Log console | — | SEND/RECEIVE with timestamps, download, and a command prompt |
| 3D device preview | — | The real model: orbit, zoom, clickable keys, live pointer output |
| Bindings shown on the device | — | Each key's binding printed on that key in the 3D view, encoders labelled on the shell beside them |
| Themes | One | Glass and flat, one attribute apart |
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

Two limits are worth stating plainly, because both are the firmware's rather
than ours:

- **A behavior's parameter types are fixed.** "Hold/tap (layer/mouse key)"
  holds a layer and taps a button because it was built that way, and no editor
  can offer a modifier in that first slot. The picker lists every other pairing
  the board has, so the way to hold something else is visible rather than
  absent.
- **The firmware cannot be downloaded by the page.** GitHub serves release
  assets without an `Access-Control-Allow-Origin` header, so a browser cannot
  read the bytes — the API's own redirect carries CORS but the asset host does
  not, and every response in a redirect chain has to pass. The original stops
  at the same wall. Everything either side of the download is automated.
