// Declarative catalogue of everything the UI can tune.
// One table drives every control, so adding a knob is one line, not a component.
// `advanced: true` tucks a control into a collapsed section — reachable, but
// not in the way of the handful of knobs most people actually want.

import { device } from "./device.js";
import { parseRtcfg, unsupported } from "./protocol.js";

export { parseRtcfg, unsupported };

const num = (text) => {
  const m = String(text).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** Firmware's own wording, lifted from the previous build. */
export const RTCFG_HELP = {
  "ac/history_ttl": "Axis clamper history time-to-live (ms). Older samples are discarded. 0 disables the clamper completely.",
  "accel/dz_before": "Check dead zone threshold before applying acceleration.",
  "accel/dz_cooldown": "Activate dead zone after this amount of msec after last non-dead-zone movement.",
  "accel/dz_enable": "Enable dead zone for pointer.",
  "accel/dz_thres": "Lower or equal values are discarded.",
  "ah/timeout_ms": "Auto hold behavior activates after this amount of msec.",
  "argb/bc1": "First critical warning at battery %.",
  "argb/bc2": "Second critical warning at battery %.",
  "argb/bc3": "Third critical warning at battery %.",
  "argb/brt": "Global brightness (%).",
  "argb/bw1": "First warning at battery %.",
  "argb/bw2": "Second warning at battery %.",
  "argb/bw3": "Third warning at battery %.",
  "argb/tick": "Tick interval for animations (ms).",
  "ec11/comp_half": "Compensate only if at least half of pulses were present.",
  "ec11/debounce_ms": "Ignore A/B line jitter for this many ms after an interrupt.",
  "ec11/do_comp": "Compensate for noisy hardware.",
  "ec11/rec_depth": "Maximum recursion depth for error correction readings.",
  "ec11/trigger_window": "Maximum amount of time to wait for all pulses.",
  "esb/quar_n": "Size of persistent quarantine.",
  "usb/quar_n": "Size of persistent quarantine.",
  "p2sm/dy_mag_div": "IS_TWISTING = twist_value > translation_value * dy_mag_mul / dy_mag_div",
  "p2sm/dy_mag_mul": "IS_TWISTING = twist_value > translation_value * dy_mag_mul / dy_mag_div",
  "p2sm/ema_alpha": "Twist scroll smoothing factor (EMA alpha, 1–100%).",
  "p2sm/fb_cooldown": "Haptic feedback cooldown period (ms) after the maximum continuous duration is reached.",
  "p2sm/fb_dur": "Twist haptic feedback pulse duration (ms).",
  "p2sm/fb_max_cont": "Maximum continuous haptic feedback for twist scroll (ms) before a cooldown is enforced.",
  "p2sm/fb_thres": "Twist feedback accumulator threshold before a haptic pulse is triggered.",
  "p2sm/feedback_en": "Enable haptic feedback for twist scroll.",
  "p2sm/frame_sync": "For high polling rate sensors, helps to avoid jitter at the cost of polling rate.",
  "p2sm/ptr_after_scroll": "Delay (ms) before re-enabling pointer movement after scroll activity ends.",
  "p2sm/scroll_dis_ptr": "Disable pointer movement while twist scrolling is active.",
  "p2sm/steady_cd": "Cooldown duration (ms) applied after steady-state threshold is crossed.",
  "p2sm/steady_thres": "Movement magnitude threshold for steady-state detection. Movements below this are considered stationary.",
  "p2sm/twist_deb": "Twist time filter debounce (ms).",
  "p2sm/twist_global_en": "Persistently enable or disable twist scroll functionality.",
  "p2sm/twist_hyst_div": "Relaxed dy_mag divisor used while a twist gesture is already active.",
  "p2sm/twist_hyst_en": "Relax twist_thres and dy_mag while a twist gesture is active, so slow continuation passes through without weakening start-of-gesture protection.",
  "p2sm/twist_hyst_mul": "Relaxed dy_mag multiplier used while a twist gesture is already active.",
  "p2sm/twist_hyst_thres": "Relaxed twist threshold used while a twist gesture is already active.",
  "p2sm/twist_thres": "Minimum twist magnitude to register as a twist event.",
  "p2sm/twist_ttl": "Time filter window (ms). Singular twist events within this timeframe are filtered out.",
  "rp/timeout_ms": "Axis sync window. Keep reasonably small.",
  "rrl/auto_off_ms": "Report rate limiter monitor auto-off timeout (ms).",
  "keymap/autoswitch": "Automatically switch keymap on output change.",
  "bst/default": "Default bistable slot: 0 for Windows/Linux, 1 for macOS.",
};

// A plain rtcfg-backed knob. Hints come from the firmware's own wording.
const cfg = (key, label, o = {}) => ({
  id: key, key, label, kind: "range", min: 0, max: 100, step: 1,
  hint: RTCFG_HELP[key], ...o,
  read: (s) => s.rtcfg[key],
  write: (v) => device.send(`rtcfg set ${key} ${Math.round(v)}`),
});

const toggle = (key, label, o = {}) => cfg(key, label, { kind: "toggle", min: 0, max: 1, ...o });

export const groups = [
  {
    id: "feel",
    label: "Feel",
    blurb: "How the ball moves the pointer.",
    controls: [
      {
        id: "sens", label: "Sensitivity", kind: "range",
        min: 0.1, max: 10, step: 0.1, unit: "x", drives: "spin",
        hint: "Higher means the pointer travels further per turn of the ball.",
        read: (s) => s.sens,
        write: (v) => device.send(`p2sm sens pointer set ${Math.floor(v * 10)}`),
      },
      {
        id: "plane", label: "Rotation", kind: "range",
        min: -180, max: 180, step: 1, unit: "°", drives: "tilt",
        hint: "Turn the whole tracking plane if the ball sits at an angle.",
        read: (s) => s.plane,
        write: (v) => device.send(`plane set pointer ${Math.round(v)}`),
      },
      {
        id: "sma", label: "Smoothing", kind: "range",
        min: 1, max: 16, step: 1, unit: " frames", drives: "smooth",
        hint: "Averages recent frames. Steadier aim, slightly more latency.",
        read: (s) => s.sma,
        write: (v) => device.send(`p2sm sma window set ${Math.round(v)}`),
      },
      {
        id: "rrl", label: "Report rate cap", kind: "range",
        min: 0, max: 1000, step: 10, unit: " Hz",
        hint: "0 leaves the rate uncapped.",
        read: (s) => s.rrl,
        write: (v) => device.send(`rrl set ${Math.round(v)}`),
      },
      toggle("accel/dz_enable", "Dead zone", { drives: "deadzone" }),
      cfg("accel/dz_thres", "Dead zone size", { max: 50, drives: "deadzone" }),

      cfg("accel/dz_cooldown", "Dead zone delay", { max: 2000, step: 10, unit: " ms", advanced: true }),
      toggle("accel/dz_before", "Dead zone before acceleration", { advanced: true }),
      toggle("p2sm/frame_sync", "Frame sync", { advanced: true }),
      cfg("p2sm/steady_thres", "Steady-state threshold", { max: 200, advanced: true }),
      cfg("p2sm/steady_cd", "Steady-state cooldown", { max: 2000, step: 10, unit: " ms", advanced: true }),
      cfg("rp/timeout_ms", "Axis sync window", { max: 100, unit: " ms", advanced: true }),
      cfg("ac/history_ttl", "Axis clamper history", { max: 1000, step: 5, unit: " ms", advanced: true }),
      cfg("rrl/auto_off_ms", "Rate monitor auto-off", { max: 60000, step: 500, unit: " ms", advanced: true }),
      cfg("ah/timeout_ms", "Auto hold delay", { max: 2000, step: 10, unit: " ms", advanced: true }),
      cfg("usb/quar_n", "USB quarantine size", { max: 64, advanced: true }),
      cfg("esb/quar_n", "Dongle quarantine size", { max: 64, advanced: true }),
    ],
  },
  {
    id: "scroll",
    label: "Scroll",
    blurb: "Twist the ball to scroll.",
    controls: [
      {
        id: "twist", label: "Twist to scroll", kind: "toggle", drives: "twist",
        hint: "Rotate the ball on the spot instead of dragging it.",
        read: (s) => s.twist,
        write: (v) => device.send(`p2sm twist ${v ? "on" : "off"}`),
      },
      {
        id: "twistSens", label: "Scroll speed", kind: "range",
        min: 0.1, max: 10, step: 0.1, unit: "x", drives: "twist",
        read: (s) => s.twistSens,
        write: (v) => device.send(`p2sm sens twist set ${Math.floor(v * 10)}`),
      },
      {
        id: "twistReverse", label: "Reverse direction", kind: "toggle",
        hint: "Flip which way a twist scrolls.",
        read: (s) => s.twistReverse,
        write: () => device.send("p2sm twist reverse"),
      },
      cfg("p2sm/twist_thres", "Twist threshold", { max: 200 }),
      cfg("p2sm/ema_alpha", "Scroll smoothing", { min: 1, max: 100, unit: "%" }),
      toggle("p2sm/feedback_en", "Haptics", { drives: "haptic" }),

      cfg("p2sm/twist_deb", "Debounce", { max: 500, step: 5, unit: " ms", advanced: true }),
      cfg("p2sm/twist_ttl", "Time filter window", { max: 1000, step: 5, unit: " ms", advanced: true }),
      toggle("p2sm/scroll_dis_ptr", "Lock pointer while scrolling", { advanced: true }),
      cfg("p2sm/ptr_after_scroll", "Pointer resume delay", { max: 1000, step: 5, unit: " ms", advanced: true }),
      toggle("p2sm/twist_global_en", "Twist scroll available", { advanced: true }),
      cfg("p2sm/dy_mag_mul", "Twist/translation multiplier", { max: 100, advanced: true }),
      cfg("p2sm/dy_mag_div", "Twist/translation divisor", { min: 1, max: 100, advanced: true }),
      toggle("p2sm/twist_hyst_en", "Twist hysteresis", { advanced: true }),
      cfg("p2sm/twist_hyst_thres", "Hysteresis threshold", { max: 200, advanced: true }),
      cfg("p2sm/twist_hyst_mul", "Hysteresis multiplier", { max: 100, advanced: true }),
      cfg("p2sm/twist_hyst_div", "Hysteresis divisor", { min: 1, max: 100, advanced: true }),
      cfg("p2sm/fb_dur", "Buzz length", { max: 100, unit: " ms", advanced: true }),
      cfg("p2sm/fb_thres", "Buzz every", { max: 200, advanced: true }),
      cfg("p2sm/fb_cooldown", "Buzz cooldown", { max: 5000, step: 10, unit: " ms", advanced: true }),
      cfg("p2sm/fb_max_cont", "Max continuous buzz", { max: 5000, step: 10, unit: " ms", advanced: true }),
    ],
  },
  {
    id: "lights",
    label: "Lights",
    blurb: "Global RGB brightness and the battery warning levels. Per-event colours live under Effects.",
    controls: [
      {
        id: "argb", label: "Lighting", kind: "toggle", drives: "glow",
        read: (s) => s.argb,
        write: (v) => device.send(`argb ${v ? "on" : "off"}`),
      },
      cfg("argb/brt", "Brightness", { max: 100, unit: "%", drives: "glow" }),
      cfg("argb/tick", "Animation tick", { min: 1, max: 200, unit: " ms", hint: "Lower is faster." }),
      cfg("argb/bw1", "Battery warning 1", { max: 100, unit: "%" }),
      cfg("argb/bw2", "Battery warning 2", { max: 100, unit: "%", advanced: true }),
      cfg("argb/bw3", "Battery warning 3", { max: 100, unit: "%", advanced: true }),
      cfg("argb/bc1", "Critical warning 1", { max: 100, unit: "%" }),
      cfg("argb/bc2", "Critical warning 2", { max: 100, unit: "%", advanced: true }),
      cfg("argb/bc3", "Critical warning 3", { max: 100, unit: "%", advanced: true }),
    ],
  },
  {
    id: "encoder",
    label: "Encoder",
    blurb: "Rotary encoder pulse handling.",
    optional: true,   // hidden when the board reports no ec11 keys
    controls: [
      toggle("ec11/do_comp", "Error correction"),
      toggle("ec11/comp_half", "Half-pulse compensation"),
      cfg("ec11/debounce_ms", "Debounce", { max: 100, unit: " ms" }),
      cfg("ec11/trigger_window", "Pulse wait window", { max: 500, unit: " ms" }),
      cfg("ec11/rec_depth", "Correction depth", { max: 16 }),
    ],
  },
];

export const allControls = groups.flatMap((g) => g.controls);

/** One pass over the device: bulk rtcfg plus the handful of dedicated reads. */
export async function readAll() {
  const state = { rtcfg: {}, missing: new Set(), status: "" };

  state.rtcfg = parseRtcfg(await device.send("rtcfg list"));

  const status = await device.send("p2sm status");
  state.status = status;
  state.twist = /Twist scroll:\s*enabled/i.test(status) ? 1 : 0;
  state.twistReverse = /Twist reversed:\s*yes/i.test(status) ? 1 : 0;
  // Brightness above zero does not mean the lighting is switched on.
  const argbState = await device.send("argb state");
  state.argb = /state:\s*on/i.test(argbState) ? 1 : 0;

  const twistPct = status.match(/Twist scroll:[^\n]*?~?(\d+\.?\d*)\s*%/i);
  state.twistSens = twistPct
    ? Number(twistPct[1])
    : (num(await device.send("p2sm sens twist get")) ?? 10) / 10;

  const sma = status.match(/SMA window:\s*(\d+)/i);
  state.sma = sma ? Number(sma[1]) : 1;

  state.sens = (num(await device.send("p2sm sens pointer get")) ?? 10) / 10;

  const plane = await device.send("plane get pointer");
  if (unsupported(plane)) state.missing.add("plane");
  else state.plane = Number(plane.match(/angle=(-?\d+)/)?.[1] ?? 0);

  const rrl = await device.send("rrl get");
  if (unsupported(rrl)) state.missing.add("rrl");
  else state.rrl = num(rrl) ?? 0;

  // Hide controls whose keys this firmware does not carry.
  for (const c of allControls) {
    if (c.key && !(c.key in state.rtcfg)) state.missing.add(c.id);
  }
  return state;
}

// node src/settings.js -> catalogue sanity (parsers are checked in protocol.js)
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("settings.js")) {
  const ids = allControls.map((c) => c.id);
  console.assert(new Set(ids).size === ids.length, "control ids must be unique");
  for (const c of allControls) {
    console.assert(typeof c.read === "function" && typeof c.write === "function", `${c.id} needs read/write`);
    if (c.kind === "range") console.assert(c.min < c.max, `${c.id} has an empty range`);
    if (c.key) console.assert(c.hint, `${c.id} has no description`);
  }
  console.log(`settings.js self-check OK (${ids.length} controls)`);
}
