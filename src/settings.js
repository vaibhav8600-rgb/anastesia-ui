// Declarative catalogue of everything the UI can tune.
// One table drives every control, so adding a knob is one line, not a component.

import { device } from "./device.js";

const num = (text) => {
  const m = String(text).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** `rtcfg list` output -> { "p2sm/twist_thres": 12, ... } */
export function parseRtcfg(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([a-z0-9_]+\/[a-z0-9_]+)\s+(-?\d+)$/i);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

const unsupported = (t) => /command not found/i.test(t);

// A plain rtcfg-backed knob.
const cfg = (key, label, o = {}) => ({
  id: key, key, label, kind: "range", min: 0, max: 100, step: 1, ...o,
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
      toggle("accel/dz_enable", "Dead zone", { drives: "deadzone", hint: "Ignore the tiniest movements so the pointer sits still." }),
      cfg("accel/dz_thres", "Dead zone size", { max: 50, drives: "deadzone", hint: "Movements at or below this are discarded." }),
      cfg("accel/dz_cooldown", "Dead zone delay", { max: 2000, step: 10, unit: " ms", hint: "Wait this long after real movement before the dead zone re-arms." }),
      toggle("p2sm/frame_sync", "Frame sync", { hint: "Cuts jitter on high polling-rate sensors, at some polling rate." }),
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
      cfg("p2sm/twist_thres", "Twist threshold", { max: 200, hint: "How far you must twist before it counts as scrolling." }),
      cfg("p2sm/twist_deb", "Debounce", { max: 500, step: 5, unit: " ms", hint: "Ignores twitchy back-and-forth twists." }),
      cfg("p2sm/ema_alpha", "Scroll smoothing", { min: 1, max: 100, unit: "%", hint: "Higher follows your hand more closely; lower glides." }),
      toggle("p2sm/scroll_dis_ptr", "Lock pointer while scrolling", { hint: "Stops the cursor drifting mid-scroll." }),
      toggle("p2sm/feedback_en", "Haptics", { drives: "haptic", hint: "A small buzz on each scroll step." }),
      cfg("p2sm/fb_dur", "Buzz length", { max: 100, unit: " ms" }),
      cfg("p2sm/fb_thres", "Buzz every", { max: 200, hint: "Scroll distance between buzzes." }),
    ],
  },
  {
    id: "lights",
    label: "Lights",
    blurb: "Onboard RGB.",
    controls: [
      {
        id: "argb", label: "Lighting", kind: "toggle", drives: "glow",
        read: (s) => s.argb,
        write: (v) => device.send(`argb ${v ? "on" : "off"}`),
      },
      cfg("argb/brt", "Brightness", { max: 100, unit: "%", drives: "glow" }),
      cfg("argb/tick", "Animation speed", { min: 1, max: 200, unit: " ms", hint: "Lower is faster." }),
      cfg("argb/bw1", "Battery warning at", { max: 100, unit: "%" }),
      cfg("argb/bc1", "Critical warning at", { max: 100, unit: "%" }),
    ],
  },
];

export const allControls = groups.flatMap((g) => g.controls);

/** One pass over the device: bulk rtcfg plus the handful of dedicated reads. */
export async function readAll() {
  const state = { rtcfg: {}, missing: new Set() };

  const rtcfg = await device.send("rtcfg list");
  state.rtcfg = parseRtcfg(rtcfg);

  const status = await device.send("p2sm status");
  state.twist = /twist scroll:\s*(on|enabled|~?\d)/i.test(status);
  state.argb = state.rtcfg["argb/brt"] > 0;

  const twistPct = status.match(/Twist scroll:\s*~?(\d+\.?\d*)%/i);
  state.twistSens = twistPct ? Number(twistPct[1]) : num(await device.send("p2sm sens twist get")) ?? 1;

  const sma = status.match(/SMA smoothing:\s*(\d+)/i);
  state.sma = sma ? Number(sma[1]) : 1;

  state.sens = (num(await device.send("p2sm sens pointer get")) ?? 10) / 10;

  const plane = await device.send("plane get pointer");
  if (unsupported(plane)) state.missing.add("plane");
  else state.plane = num(plane) ?? 0;

  const rrl = await device.send("rrl get");
  if (unsupported(rrl)) state.missing.add("rrl");
  else state.rrl = num(rrl) ?? 0;

  return state;
}

if (import.meta.vitest === undefined && typeof process !== "undefined" && process.argv?.[1]?.endsWith("settings.js")) {
  // node src/settings.js  -> self-check for the two parsers
  const sample = "  p2sm/twist_thres   12\n  argb/brt 80\nnoise line\n  accel/dz_enable  1\n";
  const p = parseRtcfg(sample);
  console.assert(p["p2sm/twist_thres"] === 12, "twist_thres");
  console.assert(p["argb/brt"] === 80, "brt");
  console.assert(p["accel/dz_enable"] === 1, "dz_enable");
  console.assert(Object.keys(p).length === 3, "ignores noise");
  console.assert(num("sensitivity: 25") === 25, "num");
  console.assert(num("angle -90 deg") === -90, "negative num");
  console.log("settings.js self-check OK");
}
