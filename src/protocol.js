// Parsers for the device shell's text output, kept apart from the UI so they
// can be checked with `node src/protocol.js`. Every regex here is written
// against real firmware output — see the self-check at the bottom for samples.

export const unsupported = (t) => /command not found/i.test(String(t));

/**
 * `rtcfg list` prints
 *   `  p2sm/ema_alpha   15  (default: 15, range: [1, 50])`
 * and keys can have three segments (`bst/<name>/s0_div`). Anchoring at end of
 * line, or assuming two segments, silently yields an empty config.
 */
export function parseRtcfg(text) {
  const out = {};
  const re = /^\s*([a-z0-9_]+(?:\/[a-z0-9_]+)+)\s+(-?\d+)\b/gim;
  let m;
  while ((m = re.exec(text)) !== null) out[m[1]] = Number(m[2]);
  return out;
}

/**
 * The same listing carries each key's default and permitted range. Reading
 * those beats hard-coding slider bounds that drift out of step with the
 * firmware — every bound we hard-coded was already wrong somewhere.
 */
export function parseRtcfgRanges(text) {
  const out = {};
  const re = /^\s*([a-z0-9_]+(?:\/[a-z0-9_]+)+)\s+(-?\d+)\s*\(default:\s*(-?\d+)(?:,\s*range:\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\])?\)/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    out[m[1]] = {
      value: Number(m[2]),
      def: Number(m[3]),
      min: m[4] === undefined ? null : Number(m[4]),
      max: m[5] === undefined ? null : Number(m[5]),
    };
  }
  return out;
}

/** `rtcfg get <key>` answers `<key> = <value>`. */
export function parseRtcfgGet(text) {
  const m = String(text).match(/=\s*(-?\d+)/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- curves

const SCALE = 100;

/** Eight ints per segment, scaled by 100, ordered start, END, cp1, cp2. */
export function toSegments(flat) {
  if (!flat?.length || flat.length % 8 !== 0) return null;
  const segs = [];
  for (let i = 0; i < flat.length; i += 8) {
    segs.push({
      start: { x: flat[i] / SCALE, y: flat[i + 1] / SCALE },
      end: { x: flat[i + 2] / SCALE, y: flat[i + 3] / SCALE },
      cp1: { x: flat[i + 4] / SCALE, y: flat[i + 5] / SCALE },
      cp2: { x: flat[i + 6] / SCALE, y: flat[i + 7] / SCALE },
    });
  }
  return segs;
}

export function toFlat(segs) {
  const out = [];
  for (const s of segs) {
    out.push(
      Math.round(s.start.x * SCALE), Math.round(s.start.y * SCALE),
      Math.round(s.end.x * SCALE), Math.round(s.end.y * SCALE),
      Math.round(s.cp1.x * SCALE), Math.round(s.cp1.y * SCALE),
      Math.round(s.cp2.x * SCALE), Math.round(s.cp2.y * SCALE),
    );
  }
  return out;
}

export const bezierAt = (s, t) => {
  const u = 1 - t;
  return {
    x: u * u * u * s.start.x + 3 * u * u * t * s.cp1.x + 3 * u * t * t * s.cp2.x + t * t * t * s.end.x,
    y: u * u * u * s.start.y + 3 * u * u * t * s.cp1.y + 3 * u * t * t * s.cp2.y + t * t * t * s.end.y,
  };
};

/** The firmware rejects curves whose X is not strictly increasing. */
export function validateCurve(segs) {
  if (!segs?.length) return "A curve needs at least one segment.";
  if (segs[0].end.x < 1) return `First point X must be at least 1 (now ${segs[0].end.x.toFixed(2)}).`;
  let prev = -Infinity;
  for (let i = 0; i < segs.length; i++) {
    for (let k = 0; k <= 50; k++) {
      if (i > 0 && k === 0) continue;
      const p = bezierAt(segs[i], k / 50);
      if (p.x <= prev + 1e-4) return `X must keep increasing; it doubles back in segment ${i + 1}.`;
      prev = p.x;
    }
  }
  return null;
}

/** `curve status` lists devices and their stored curve data. */
export function parseCurveStatus(text) {
  const devices = [];
  const data = {};
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const d = line.match(/^(\w+)\s+\(up to (\d+) curve\(s\), (\d+) point\(s\) interpolation\)/);
    if (d) { devices.push({ name: d[1], maxCurves: +d[2], maxPoints: +d[3] }); continue; }
    const dev = line.match(/^Device:\s+(\w+)/);
    if (dev) { current = dev[1]; continue; }
    const cur = line.match(/^Curve:\s+(.+)/);
    if (cur && current) {
      const nums = cur[1].trim().split(/\s+/).map(Number);
      if (!nums.some(Number.isNaN) && nums.length % 8 === 0) {
        data[current] = (data[current] ?? []).concat(nums);
      }
    }
  }
  return { devices, data };
}

// --------------------------------------------------------------- effects

export const EASINGS = [
  "linear", "quad-in", "quad-out", "quad-in-out", "cubic-in", "cubic-out",
  "cubic-in-out", "quart-in", "quart-out", "quart-in-out", "expo-in",
  "expo-out", "bounce-out", "bounce-in",
];

/** `argb list` -> [{ name, label }] */
export function parseEventList(text) {
  const out = [];
  for (const part of text.trim().split(/,\s*/)) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.+?)\s+\((.+)\)$/);
    if (m) out.push({ name: m[1].trim(), label: m[2].trim() });
    else if (/^layer\s+\d+$/.test(s)) out.push({ name: s, label: null });
  }
  return out;
}

/** `argb evt <name> show` -> the event's settings. */
export function parseEvent(text, name) {
  const colors = [];
  const re = /\[\d+\]\s+r=(\d+)\s+g=(\d+)\s+b=(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) colors.push({ r: +m[1], g: +m[2], b: +m[3] });

  const blink = text.match(/blink:\s*on=(\d+)ms\s+off=(\d+)ms/);
  const easeIn = text.match(/flash-ease-in:\s*(\d+)ms\s+fn=(\S+)/);
  const easeOut = text.match(/flash-ease-out:\s*(\d+)ms\s+fn=(\S+)/);
  const fb = text.match(/feedback:\s*\[([^\]]*)\]/);

  return {
    name,
    label: text.match(/label:\s*(.+)/)?.[1]?.trim() ?? null,
    anim: text.match(/anim:\s*(\w+)/)?.[1] ?? "solid",
    colors: colors.length ? colors : [{ r: 0, g: 0, b: 0 }],
    blinkOnMs: blink ? +blink[1] : 100,
    blinkOffMs: blink ? +blink[2] : 100,
    breatheDurMs: +(text.match(/breathe:\s*(\d+)ms/)?.[1] ?? 1000),
    flashDurMs: +(text.match(/flash-dur:\s*(\d+)ms/)?.[1] ?? 200),
    flashEaseInMs: easeIn ? +easeIn[1] : 0,
    flashEaseInFn: EASINGS.includes(easeIn?.[2]) ? easeIn[2] : "linear",
    flashEaseOutMs: easeOut ? +easeOut[1] : 0,
    flashEaseOutFn: EASINGS.includes(easeOut?.[2]) ? easeOut[2] : "linear",
    feedback: fb ? fb[1].split(/\s+/).filter(Boolean).map(Number) : [],
  };
}

/** Flash needs room for both eases inside its duration. */
export function validateEvent(e) {
  if (!e.colors.length) return "At least one colour is required.";
  if (e.colors.length > 4) return "Maximum of four colours.";
  if (e.anim === "solid" && e.colors.length !== 1) return "Solid uses exactly one colour.";
  if (e.anim === "flash" && e.flashEaseInMs + e.flashEaseOutMs >= e.flashDurMs) {
    return `Fade-in (${e.flashEaseInMs}ms) + fade-out (${e.flashEaseOutMs}ms) must be under the flash duration (${e.flashDurMs}ms).`;
  }
  return null;
}

// ---------------------------------------------------------------- keymap

/** `keymap status` -> slots, and whether the live keymap is unsaved. */
export function parseKeymap(text) {
  const slots = [];
  let changed = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.includes("Your current keymap has changes")) changed = true;
    const m = line.match(/^>?\s*Slot (\d+):\s*(.+)$/);
    if (!m) continue;
    const id = Number(m[1]);
    const active = line.startsWith(">");
    if (m[2].trim() === "unoccupied") slots.push({ id, occupied: false, active });
    else slots.push({
      id,
      occupied: true,
      active,
      bytes: Number(m[2].match(/(\d+) bytes/)?.[1]) || undefined,
      name: m[2].match(/name "([^"]+)"/)?.[1],
    });
  }
  return { slots, changed };
}

/** `keymap assign` -> { usb: "name" | null, ... } */
export function parseAssignments(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const m = raw.trim().match(/^(usb|wireless-\d+)\s+(.+)$/);
    if (m) out[m[1]] = m[2].trim() === "(none)" ? null : m[2].trim();
  }
  return out;
}

/**
 * The firmware reports a maximum of 728 where the true scale is 1000. The
 * previous UI carried the same substitution (`max === 728 ? 1e3 : max`); it is
 * a hardware quirk, not a display preference, so keep it here where the value
 * is parsed. `reportedMax` preserves what the board actually said.
 */
export const SURFACE_MAX_FIX = { 728: 1000 };

/** `sensor surface` -> [{ sensor, quality, max, reportedMax }] */
export function parseSurface(text) {
  const out = [];
  // Seen as "= 664/1000"; also accept "= 664 / 1000", "(max 1000)" and a bare
  // value, rather than silently rendering nothing when the wording shifts.
  const re = /Sensor\s*#?(\d+)\s*:\s*surface\s*quality\s*[:=]\s*(\d+)\s*(?:\/\s*(\d+)|\(\s*max\s*[:=]?\s*(\d+)\s*\))?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const reported = m[3] ?? m[4];
    const reportedMax = reported === undefined ? null : +reported;
    out.push({
      sensor: +m[1],
      quality: +m[2],
      max: reportedMax === null ? null : (SURFACE_MAX_FIX[reportedMax] ?? reportedMax),
      reportedMax,
    });
  }
  return out;
}

// ------------------------------------------------------------ board status

/** `board status` -> firmware + battery, falling back to `board version`. */
export function parseBoardStatus(status, version) {
  // battery null means the board answered but reports no level; undefined
  // means we have not had an answer yet.
  const out = { version: null, battery: null };
  // An unsupported `board status` prints the command's help text instead.
  if (!status || unsupported(status) || status.includes("Control the device")) {
    out.version = version?.match(/Firmware version:\s*(\S+)/)?.[1] ?? null;
    return out;
  }
  out.version = status.match(/Firmware:\s*v?(\S+)/i)?.[1] ?? null;
  const b = status.match(/Batt(?:ery)?\s*(?:level)?\s*[:=]\s*(\d+)/i);
  if (b) out.battery = Number(b[1]);
  return out;
}

export function parseOutput(text) {
  return text?.match(/Output:\s*(USB|BLE|ESB)/i)?.[1]?.toUpperCase() ?? null;
}

export const studioLocked = (t) => /Unlock ZMK Studio first/i.test(String(t));

// ------------------------------------------------------------ self-check
// node src/protocol.js

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("protocol.js")) {
  const eq = (a, b, msg) => console.assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}`);

  // rtcfg: value column, not the default; three-segment keys; negatives
  const cfg = parseRtcfg([
    "  p2sm/twist_thres          12   (default: 40)",
    "  argb/brt                  80   (default: 60)",
    "  bst/mymap/s0_div           3   (default: 1)",
    "  rp/timeout_ms             -2   (default: 0)",
    "not a setting line",
  ].join("\n"));
  eq(cfg["p2sm/twist_thres"], 12, "reads the value, not the default");
  eq(cfg["bst/mymap/s0_div"], 3, "three-segment key");
  eq(cfg["rp/timeout_ms"], -2, "negative value");
  eq(Object.keys(cfg).length, 4, "ignores noise");

  // ranges, from output captured off a real board
  const listing = [
    "  p2sm/scroll_dis_ptr          1  (default: 1, range: [0, 1])",
    "  p2sm/ptr_after_scroll      100  (default: 100, range: [0, 5000])",
    "  p2sm/ema_alpha              15  (default: 15, range: [1, 50])",
    "  p2sm/twist_dy_mag_mul        2  (default: 2, range: [1, 100])",
    "  p2sm/twist_act_ms           16  (default: 16, range: [0, 5000])",
    "  legacy/no_range              7  (default: 7)",
  ].join(String.fromCharCode(10));
  const vals = parseRtcfg(listing);
  eq(vals["p2sm/ema_alpha"], 15, "value not the default");
  eq(vals["p2sm/twist_dy_mag_mul"], 2, "twist-prefixed key");
  const meta = parseRtcfgRanges(listing);
  eq(meta["p2sm/ema_alpha"], { value: 15, def: 15, min: 1, max: 50 }, "range parsed");
  eq(meta["p2sm/ptr_after_scroll"].max, 5000, "wide range");
  eq(meta["legacy/no_range"], { value: 7, def: 7, min: null, max: null }, "range is optional");
  eq(Object.keys(meta).length, 6, "every line has meta");
  eq(parseRtcfgGet("p2sm/frame_sync = 1"), 1, "rtcfg get");
  eq(parseRtcfgGet("bst/default = 0"), 0, "rtcfg get zero");
  eq(parseRtcfgGet("nope"), null, "rtcfg get miss");

  // curves: round-trip, and the start/END/cp1/cp2 ordering
  const flat = [0, 0, 116, 41, 10, 32, 16, 39];
  const segs = toSegments(flat);
  eq(segs[0].end.x, 1.16, "third pair is END, not cp1");
  eq(segs[0].cp1.x, 0.1, "fifth pair is cp1");
  eq(toFlat(segs), flat, "flat -> segments -> flat round-trips");
  eq(toSegments([1, 2, 3]), null, "rejects a non-multiple of 8");
  eq(validateCurve(segs), null, "the stock pointer segment is valid");
  eq(validateCurve(toSegments([0, 0, 500, 41, 10, 32, 16, 39])), null, "end.x of 5 clears the >= 1 rule");
  console.assert(validateCurve(toSegments([0, 0, 50, 41, 10, 32, 16, 39])) !== null, "end.x of 0.5 is rejected");
  console.assert(validateCurve(toSegments([0, 0, 50, 10, 900, 5, 10, 8])) !== null, "catches x doubling back");
  console.assert(validateCurve([]) !== null, "rejects an empty curve");

  const cs = parseCurveStatus([
    "pointer (up to 2 curve(s), 8 point(s) interpolation)",
    "scroll (up to 1 curve(s), 8 point(s) interpolation)",
    "Device: pointer",
    "Curve: 0 0 116 41 10 32 16 39",
    "Device: scroll",
    "Curve: 0 0 102 100 10 38 10 100",
  ].join("\n"));
  eq(cs.devices.length, 2, "two curve devices");
  eq(cs.devices[0].maxPoints, 8, "interpolation points");
  eq(cs.data.pointer.length, 8, "pointer curve data");

  // effects
  const list = parseEventList('idle (Idle), ble-profile 1 (Bluetooth profile 1), layer 0');
  eq(list.length, 3, "three events");
  eq(list[1].name, "ble-profile 1", "bluetooth profile event");
  eq(list[2].label, null, "bare layer event");

  const evt = parseEvent([
    "[ble-profile 1]",
    "label: Bluetooth profile 1",
    "anim: flash",
    "colors: 2",
    "  [0] r=124 g=212 b=255",
    "  [1] r=255 g=160 b=106",
    "blink: on=120ms off=80ms",
    "flash-dur: 250ms",
    "flash-ease-in: 40ms fn=quad-in",
    "flash-ease-out: 60ms fn=bogus-fn",
    "breathe: 1500ms",
    "feedback: [30 20 30]",
  ].join("\n"), "ble-profile 1");
  eq(evt.colors.length, 2, "two colours");
  eq(evt.colors[0], { r: 124, g: 212, b: 255 }, "first colour");
  eq(evt.blinkOnMs, 120, "blink on");
  eq(evt.flashEaseInFn, "quad-in", "known easing kept");
  eq(evt.flashEaseOutFn, "linear", "unknown easing falls back");
  eq(evt.feedback, [30, 20, 30], "vibration pattern");

  eq(validateEvent({ ...evt, anim: "flash" }), null, "40+60 < 250 is fine");
  console.assert(validateEvent({ ...evt, anim: "flash", flashDurMs: 90 }) !== null, "eases must fit the flash");
  console.assert(validateEvent({ ...evt, anim: "solid" }) !== null, "solid takes one colour");
  console.assert(validateEvent({ ...evt, colors: [] }) !== null, "needs a colour");

  // keymap
  const km = parseKeymap([
    "Your current keymap has changes",
    "> Slot 0: 812 bytes, name \"default\"",
    "  Slot 1: unoccupied",
    "  Slot 2: 804 bytes, name \"mac\"",
  ].join("\n"));
  eq(km.changed, true, "unsaved changes flagged");
  eq(km.slots.length, 3, "three slots");
  eq(km.slots[0].active, true, "> marks the active slot");
  eq(km.slots[0].name, "default", "slot name");
  eq(km.slots[0].bytes, 812, "slot size");
  eq(km.slots[1].occupied, false, "unoccupied slot");

  const as = parseAssignments("usb default\nwireless-1 mac\nwireless-2 (none)\n");
  eq(as["usb"], "default", "usb assignment");
  eq(as["wireless-2"], null, "(none) becomes null");

  const surf = parseSurface("Sensor #0: surface quality = 240/361\nSensor #1: surface quality = 96/361");
  eq(surf.length, 2, "two sensors");
  eq(surf[0].quality, 240, "quality");

  // board status
  const NL = String.fromCharCode(10);
  const bs = parseBoardStatus("Firmware: v1.4.4" + NL + "Battery: 95" + NL + "Output: BLE", null);
  eq(bs.version, "1.4.4", "firmware from status");
  eq(bs.battery, 95, "battery from status");
  eq(parseBoardStatus("Firmware: 2.0.1" + NL + "Batt: 42", null).battery, 42, "short spelling");
  eq(parseBoardStatus("Firmware: 2.0.1", null).battery, null, "no level reported");
  const help = parseBoardStatus("Control the device", "Firmware version: 0.9.9");
  eq(help.version, "0.9.9", "falls back to board version");
  eq(help.battery, null, "help text carries no battery");
  eq(parseOutput("Output: usb"), "USB", "output normalised");
  eq(parseOutput("nothing"), null, "no output line");

  console.assert(unsupported("plane: command not found"), "unsupported detected");
  console.assert(studioLocked("Unlock ZMK Studio first"), "studio lock detected");

  console.log("protocol.js self-check OK");
}
