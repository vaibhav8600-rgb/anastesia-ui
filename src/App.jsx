import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { device, supported } from "./device.js";
import {
  sensorSections, lightControls, allControls, readAll, resolveSpec,
  RTCFG_HELP, autoLabel,
} from "./settings.js";
import Trackball, { hasWebGL } from "./Trackball.jsx";
import Control from "./Control.jsx";
import Curves from "./Curves.jsx";
import Effects from "./Effects.jsx";
import Logs from "./Logs.jsx";
import { Keymap, ImportExport, Surface } from "./Board.jsx";
import Status from "./Status.jsx";

// The seven tabs mirror the original's shape, so anyone coming from it knows
// where to look.
const TABS = [
  { id: "keymap", label: "Keymap" },
  { id: "acceleration", label: "Acceleration" },
  { id: "sensors", label: "Sensor(s)" },
  { id: "effects", label: "Effects" },
  { id: "io", label: "Import/Export" },
  { id: "raw", label: "Raw settings" },
  { id: "logs", label: "Logs" },
];

const DEMO_RTCFG = {
  "accel/dz_enable": 1, "accel/dz_thres": 6, "accel/dz_cooldown": 120, "accel/dz_before": 0,
  "p2sm/frame_sync": 1, "p2sm/steady_thres": 12, "p2sm/steady_cd": 150,
  "p2sm/twist_thres": 40, "p2sm/twist_deb": 25, "p2sm/twist_ttl": 120,
  "p2sm/twist_act_ms": 16, "p2sm/ema_alpha": 15,
  "p2sm/scroll_dis_ptr": 1, "p2sm/ptr_after_scroll": 100,
  "p2sm/twist_global_en": 1, "p2sm/twist_dy_mag_mul": 2, "p2sm/twist_dy_mag_div": 1,
  "p2sm/twist_hyst_en": 1, "p2sm/twist_hyst_thres": 25, "p2sm/twist_hyst_mul": 2, "p2sm/twist_hyst_div": 3,
  "p2sm/feedback_en": 1, "p2sm/fb_dur": 12, "p2sm/fb_thres": 30,
  "p2sm/fb_cooldown": 400, "p2sm/fb_max_cont": 1200,
  "rp/timeout_ms": 4, "ac/history_ttl": 80, "rrl/auto_off_ms": 30000,
  "ah/timeout_ms": 250, "usb/quar_n": 8, "esb/quar_n": 8,
  "argb/brt": 60, "argb/tick": 30,
  "argb/bw1": 25, "argb/bw2": 15, "argb/bw3": 10,
  "argb/bc1": 8, "argb/bc2": 5, "argb/bc3": 3,
  "ec11/do_comp": 1, "ec11/comp_half": 1, "ec11/debounce_ms": 3,
  "ec11/trigger_window": 40, "ec11/rec_depth": 4,
  "keymap/autoswitch": 1, "bst/default": 0,
};

// Ranges the demo pretends the firmware reported, so sliders behave as they
// would on a real board.
const DEMO_RANGES = Object.fromEntries(Object.entries(DEMO_RTCFG).map(([k, v]) => {
  const known = {
    "p2sm/ema_alpha": [1, 50], "p2sm/ptr_after_scroll": [0, 5000],
    "p2sm/twist_dy_mag_mul": [1, 100], "p2sm/twist_dy_mag_div": [1, 100],
    "p2sm/twist_act_ms": [0, 5000], "argb/brt": [0, 100], "argb/tick": [1, 200],
    "rrl/auto_off_ms": [0, 60000],
  }[k] ?? (v === 0 || v === 1 ? [0, 1] : [0, Math.max(100, v * 4)]);
  return [k, { value: v, def: v, min: known[0], max: known[1] }];
}));

const DEMO_STATE = {
  rtcfg: DEMO_RTCFG,
  ranges: DEMO_RANGES,
  sens: 3.2, plane: 0, sma: 4, rrl: 0,
  twist: 1, twistSens: 2.5, twistReverse: 0, argb: 1,
  missing: new Set(),
};

export default function App() {
  const [status, setStatus] = useState(() =>
    new URLSearchParams(location.search).has("demo") ? "demo" : "idle");
  const [note, setNote] = useState(null);
  const [state, setState] = useState(null);
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState(() => new Set());
  const [tab, setTab] = useState("sensors");
  // Panels talk to the device when they mount, so a visited tab stays mounted
  // and is only hidden — returning to it costs nothing.
  const [visited, setVisited] = useState(() => new Set(["sensors"]));
  const [log, setLog] = useState([]);
  const [firmware, setFirmware] = useState(null);
  const scrollHint = useRef(null);

  useEffect(() => device.onLog((e) => setLog((l) => [...l.slice(-400), e])), []);

  const seed = useCallback((s) => {
    setState(s);
    const next = {};
    for (const c of allControls) {
      const v = c.read(s);
      if (v != null) next[c.id] = v;
    }
    setValues(next);
    setDirty(new Set());
  }, []);

  const connect = async (kind) => {
    setStatus("busy");
    setNote(kind === "usb" ? "Waiting for you to pick a port…" : "Scanning for your trackball…");
    try {
      await (kind === "usb" ? device.connectUSB() : device.connectBLE());
      setNote("Reading settings…");
      seed(await readAll());
      setStatus("ready");
      setNote(null);
    } catch (err) {
      setStatus("idle");
      setNote(err?.name === "NotFoundError" ? "No device picked." : String(err?.message ?? err));
    }
  };

  const disconnect = async () => {
    await device.disconnect();
    setStatus("idle");
    setState(null);
    setValues({});
    setDirty(new Set());
    setVisited(new Set(["sensors"]));
    setTab("sensors");
  };

  const change = (id, v) => {
    setValues((prev) => ({ ...prev, [id]: v }));
    setDirty((prev) => new Set(prev).add(id));
  };

  const save = async () => {
    if (status !== "ready") {
      setDirty(new Set());
      setNote("Demo mode — nothing was written.");
      return;
    }
    setStatus("busy");
    setNote("Saving…");
    try {
      const written = {};
      for (const id of dirty) {
        const spec = allControls.find((c) => c.id === id);
        if (!spec) continue;
        await spec.write(values[id]);
        if (spec.key) written[spec.key] = Math.round(values[id]);
      }
      // Raw settings and the export both read state.rtcfg, so it has to follow
      // what we just wrote or they show stale numbers.
      setState((s) => ({ ...s, rtcfg: { ...s.rtcfg, ...written } }));
      setDirty(new Set());
      setNote("Saved.");
      setTimeout(() => setNote(null), 2000);
    } catch (err) {
      setNote(`Could not save: ${err.message}`);
    } finally {
      setStatus("ready");
    }
  };

  const revert = () => state && seed(state);

  const scene = useMemo(() => ({
    sens: values.sens,
    plane: values.plane,
    sma: values.sma,
    deadzone: values["accel/dz_enable"],
    deadzoneSize: values["accel/dz_thres"],
    twist: values.twist,
    twistSens: values.twistSens,
    glow: values.argb,
    brightness: values["argb/brt"],
  }), [values]);

  const onScrollTick = useCallback((dir) => {
    const el = scrollHint.current;
    if (!el) return;
    el.textContent = dir > 0 ? "scroll ▼" : "scroll ▲";
    el.dataset.live = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.dataset.live = "0"; }, 600);
  }, []);

  const startDemo = useCallback(() => { seed(DEMO_STATE); setStatus("demo"); }, [seed]);
  useEffect(() => { if (status === "demo") startDemo(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) {
    return <Welcome status={status} note={note} onConnect={connect} onDemo={startDemo} />;
  }

  const live = status === "ready";
  const open = (id) => { setTab(id); setVisited((v) => new Set(v).add(id)); };

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">
          <strong>Anastesia</strong>
          <em>by Vaibhav Rajput</em>
        </span>
        {!live && <span className="chip">Demo</span>}
        <div className="bar__spacer" />
        <Status live={live} onFirmware={setFirmware} />
        {dirty.size > 0 && <button className="btn btn--ghost" onClick={revert}>Revert</button>}
        <button className="btn btn--primary" onClick={save} disabled={dirty.size === 0 || status === "busy"}>
          {dirty.size > 0 ? `Save ${dirty.size}` : "Saved"}
        </button>
        <button className="btn btn--ghost" onClick={disconnect}>{live ? "Disconnect" : "Exit"}</button>
      </header>

      {/* The console wants the whole width; everything else keeps the preview. */}
      <main className={"stage" + (tab === "logs" ? " stage--wide" : "")}>
        <section className="stage__view">
          <Trackball values={scene} onScrollTick={onScrollTick} />
          <p className="stage__caption">
            {hasWebGL()
              ? "Drag the ball to feel your settings."
              : "This device has no 3D preview, but every setting below still works."}
            <span className="ticker" ref={scrollHint} data-live="0" />
          </p>
        </section>

        <section className="stage__panel">
          <nav className="tabs" role="tablist" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={"tab" + (tab === t.id ? " is-active" : "")}
                onClick={() => open(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className={"panel" + (tab === "logs" ? " panel--flush" : "")} role="tabpanel">
            <Pane active={tab === "keymap"} visited={visited.has("keymap")}>
              <Keymap live={live} onNote={setNote} />
            </Pane>

            <Pane active={tab === "acceleration"} visited={visited.has("acceleration")}>
              <Curves live={live} onNote={setNote} />
            </Pane>

            <Pane active={tab === "sensors"} visited={visited.has("sensors")}>
              {sensorSections
                .filter((sec) => !sec.optional || sec.controls.some((c) => !state.missing.has(c.id)))
                .map((sec) => (
                  <KnobSection
                    key={sec.id}
                    section={sec}
                    state={state}
                    values={values}
                    busy={status === "busy"}
                    onChange={change}
                  />
                ))}
              <details className="sub">
                <summary>Sensor surface quality</summary>
                <Surface live={live} onNote={setNote} />
              </details>
            </Pane>

            <Pane active={tab === "effects"} visited={visited.has("effects")}>
              <KnobSection
                section={{ id: "lights", label: "Lighting", blurb: "Global brightness and battery warning levels.", controls: lightControls }}
                state={state}
                values={values}
                busy={status === "busy"}
                onChange={change}
              />
              <h3 className="sec">Per-event colour</h3>
              <Effects live={live} onNote={setNote} />
            </Pane>

            <Pane active={tab === "io"} visited={visited.has("io")}>
              <ImportExport live={live} onNote={setNote} rtcfg={state.rtcfg} firmware={firmware} />
            </Pane>

            <Pane active={tab === "raw"} visited={visited.has("raw")}>
              <Raw rtcfg={state.rtcfg} ranges={state.ranges} live={live} onNote={setNote} />
            </Pane>

            <Pane active={tab === "logs"} visited={visited.has("logs")}>
              <Logs log={log} onClear={() => setLog([])} live={live} onNote={setNote} />
            </Pane>
          </div>
        </section>
      </main>

      {note && <p className="toast" role="status">{note}</p>}
    </div>
  );
}

/** Mounted once visited, hidden rather than torn down when you switch away. */
function Pane({ active, visited, children }) {
  if (!visited) return null;
  return <div hidden={!active}>{children}</div>;
}

/** A titled run of knobs, with the long tail folded away. */
function KnobSection({ section, state, values, busy, onChange }) {
  const shown = section.controls
    .filter((c) => !state.missing.has(c.id))
    .map((c) => resolveSpec(c, state.ranges));
  const main = shown.filter((c) => !c.advanced);
  const advanced = shown.filter((c) => c.advanced);

  if (!shown.length) return null;

  const render = (c) => (
    <Control key={c.id} spec={c} value={values[c.id]} disabled={busy} onChange={(v) => onChange(c.id, v)} />
  );

  return (
    <section className="knobs">
      <h3 className="sec">{section.label}</h3>
      {section.blurb && <p className="panel__blurb">{section.blurb}</p>}
      {main.map(render)}
      {advanced.length > 0 && (
        <details className="sub">
          <summary>Advanced ({advanced.length})</summary>
          {advanced.map(render)}
        </details>
      )}
    </section>
  );
}

function Welcome({ status, note, onConnect, onDemo }) {
  const none = !supported.usb && !supported.ble;
  return (
    <div className="welcome">
      <Trackball values={{ sens: 4, sma: 3, glow: 1, brightness: 70 }} />
      <div className="welcome__copy">
        <h1>Anastesia</h1>
        <p>Tune your trackball by feel. Spin the ball — that is the preview, and it moves the way your settings will.</p>
        {none ? (
          <p className="warn">
            This browser cannot talk to USB or Bluetooth devices. Use Chrome, Edge or another
            Chromium browser to connect — or take a look around in demo mode.
          </p>
        ) : (
          <div className="welcome__actions">
            {supported.usb && (
              <button className="btn btn--primary" onClick={() => onConnect("usb")} disabled={status === "busy"}>
                Connect over USB
              </button>
            )}
            {supported.ble && (
              <button className="btn" onClick={() => onConnect("ble")} disabled={status === "busy"}>
                Connect over Bluetooth
              </button>
            )}
          </div>
        )}
        <button className="btn btn--ghost" onClick={onDemo}>Try it without a device</button>
        {note && <p className="toast toast--inline" role="status">{note}</p>}
        <p className="app-byline">Anastesia-UI · by Vaibhav Rajput</p>
      </div>
    </div>
  );
}

/** Every runtime parameter the firmware reports, flat and searchable. */
function Raw({ rtcfg, ranges, live, onNote }) {
  const [q, setQ] = useState("");
  const keys = Object.keys(rtcfg)
    .filter((k) => k.toLowerCase().includes(q.toLowerCase().trim()))
    .sort();

  const set = async (key, v) => {
    if (!live) { onNote("Demo mode — nothing was written."); return; }
    try {
      await device.send(`rtcfg set ${key} ${v}`);
      onNote(`${key} = ${v}`);
    } catch (err) {
      onNote(err.message);
    }
  };

  return (
    <>
      <p className="panel__blurb">
        Runtime configuration parameters stored on the device. Changes here apply immediately.
      </p>
      <input
        className="search"
        type="search"
        placeholder={`Filter ${Object.keys(rtcfg).length} parameters`}
        aria-label="Filter parameters"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="raw">
        {keys.map((k) => {
          const r = ranges?.[k];
          return (
            <li key={k}>
              <span className="raw__key">
                <code>{k}</code>
                <span className="raw__hint">
                  {RTCFG_HELP[k] ?? autoLabel(k)}
                  {r && r.min !== null && <em> · {r.min}–{r.max}, default {r.def}</em>}
                </span>
              </span>
              <input
                type="number"
                min={r?.min ?? undefined}
                max={r?.max ?? undefined}
                defaultValue={rtcfg[k]}
                aria-label={k}
                onBlur={(e) => Number(e.target.value) !== rtcfg[k] && set(k, e.target.value)}
              />
            </li>
          );
        })}
        {keys.length === 0 && <li className="raw__empty">Nothing matches “{q}”.</li>}
      </ul>
    </>
  );
}
