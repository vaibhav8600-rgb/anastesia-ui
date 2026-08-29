import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { device, supported } from "./device.js";
import {
  sensorSections, lightControls, LIGHT_PREFIXES, allControls, readAll,
  resolveSpec, extraControls, RTCFG_HELP, autoLabel,
} from "./settings.js";
import Trackball, { hasWebGL } from "./Trackball.jsx";
import Control from "./Control.jsx";
import Curves from "./Curves.jsx";
import Effects from "./Effects.jsx";
import Logs from "./Logs.jsx";
import { Keymap, ImportExport, Surface } from "./Board.jsx";
import Heatmap from "./Heatmap.jsx";
import RollMap from "./RollMap.jsx";
import Status from "./Status.jsx";

// The seven tabs mirror the original's shape, so anyone coming from it knows
// where to look.
// Every key any curated control owns. A section's prefix fill must skip all of
// them, or a key curated elsewhere is duplicated into whichever section claims
// its prefix — p2sm/frame_sync lives under Pointer but Twist scroll claims p2sm/.
const CURATED_KEYS = new Set(allControls.map((c) => c.key).filter(Boolean));

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
  "bst/default": 0,
  "bst/snipe/s0_mult": 1, "bst/snipe/s0_div": 4,
  "bst/snipe/s1_mult": 1, "bst/snipe/s1_div": 4,
  "bst/twist/s0_mult": 1, "bst/twist/s0_div": 10,
  "bst/twist/s1_mult": 1, "bst/twist/s1_div": 40,
  "bst/dragscroll/s0_mult": 1, "bst/dragscroll/s0_div": 3,
  "bst/dragscroll/s1_mult": 1, "bst/dragscroll/s1_div": 30,
  "ec11/do_comp": 1, "ec11/comp_half": 1, "ec11/debounce_ms": 3,
  "ec11/trigger_window": 40, "ec11/rec_depth": 4,
  "keymap/autoswitch": 1,
};

// Ranges the demo pretends the firmware reported, so sliders behave as they
// would on a real board.
const DEMO_RANGES = Object.fromEntries(Object.entries(DEMO_RTCFG).map(([k, v]) => {
  // Scaling multipliers sit at 1 by default, and the generic "0 or 1 means a
  // switch" guess below would render them as toggles.
  if (/^bst\/[a-z0-9_]+\/s[01]_(mult|div)$/.test(k)) return [k, { value: v, def: v, min: 1, max: 100 }];
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
  sens: 3.2, plane: 0, sma: 4, rrl: 4,
  twist: 1, twistSens: 2.5, twistReverse: 0, argb: 1,
  // Hide the same controls a real board would, so demo does not show both
  // spellings of a renamed key side by side.
  missing: new Set(
    allControls.filter((c) => c.key && !(c.key in DEMO_RTCFG)).map((c) => c.id),
  ),
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
    // Every rtcfg key first. Controls filled in from the device's own listing
    // are built inside KnobSection, so they never appear in allControls — and
    // without a value here every one of them rendered as its slider minimum
    // instead of what the board actually reports. Their id is the key itself.
    const next = { ...(s.rtcfg ?? {}) };
    for (const c of allControls) {
      const v = c.read(s);
      if (v != null) next[c.id] = v;
    }
    setValues(next);
    setDirty(new Set());
  }, []);

  const connect = async (kind) => {
    setStatus("busy");
    setNote(kind === "usb" ? "Pick your device, then wait for its shell…" : "Scanning, then waiting for the shell…");
    try {
      await (kind === "ble" ? device.connectBLE() : device.connectUSB({ all: kind === "usb-all" }));
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
        if (spec) {
          await spec.write(values[id]);
          if (spec.key) written[spec.key] = Math.round(values[id]);
          continue;
        }
        // Not in the catalogue means it came from the device listing, where the
        // id is the rtcfg key. This used to `continue`, so every edit to one of
        // those was dropped without a word — it cleared from the dirty set and
        // the panel reported "Saved".
        if (id in state.rtcfg) {
          const v = Math.round(values[id]);
          await device.send(`rtcfg set ${id} ${v}`);
          written[id] = v;
        }
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
    return (
      <Welcome
        status={status}
        note={note}
        log={log}
        onConnect={connect}
        onDemo={startDemo}
        onClearLog={() => setLog([])}
      />
    );
  }

  // "is there a device" is not the same question as "is a command in flight".
  // Deriving it from status === "ready" meant every save flipped this false for
  // its duration, and each panel fell back to its demo data mid-save — the
  // status bar included, which is how a placeholder 95% reached a live board.
  const live = status !== "demo";
  const busy = status === "busy";
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
        <button className="btn btn--primary" onClick={save} disabled={dirty.size === 0 || busy}>
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
              ? "Roll the ball · drag the body to turn · scroll to zoom"
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
              <Surface live={live} onNote={setNote} active={tab === "sensors"} />
              {sensorSections
                .filter((sec) => !sec.optional || hasAnything(sec, state))
                .map((sec) => (
                  <KnobSection
                    key={sec.id}
                    section={sec}
                    state={state}
                    values={values}
                    busy={busy}
                    onChange={change}
                  />
                ))}
              <RollMap live={live} />
              <Heatmap live={live} onNote={setNote} />
            </Pane>

            <Pane active={tab === "effects"} visited={visited.has("effects")}>
              <KnobSection
                section={{
                  id: "lights",
                  label: "Lighting",
                  blurb: "Global brightness and battery warning levels.",
                  controls: lightControls,
                  prefixes: LIGHT_PREFIXES,
                }}
                state={state}
                values={values}
                busy={busy}
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

/**
 * Advanced settings in declaration order are one long undifferentiated run.
 * Each control names the sub-group it belongs to, and they are gathered here
 * in first-seen order so the grouping stays predictable.
 */
/**
 * Does an optional section have anything to show? Its own controls count, and
 * so do keys the firmware reports under its prefixes — the scaling section is
 * almost entirely prefix-filled, so judging it on curated controls alone hid a
 * dozen live settings.
 */
function hasAnything(sec, state) {
  if (sec.controls.some((c) => !state.missing.has(c.id))) return true;
  return (sec.prefixes ?? []).some((p) =>
    Object.keys(state.rtcfg).some((k) => k.startsWith(p)));
}

/**
 * Dials read best side by side, but they must not jump ahead of the rows they
 * were declared after — the twist master switch belongs above the scroll-speed
 * dial, not below it. So gather only *adjacent* dials into a row and leave
 * everything else exactly where the catalogue put it.
 */
function runs(controls) {
  const out = [];
  for (const c of controls) {
    const last = out[out.length - 1];
    if (c.hero && last?.hero) last.items.push(c);
    else out.push({ hero: !!c.hero, items: [c] });
  }
  return out;
}

function groupByAdv(controls) {
  const out = new Map();
  for (const c of controls) {
    const key = c.adv ?? "Other";
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(c);
  }
  return [...out];
}

/** Mounted once visited, hidden rather than torn down when you switch away. */
function Pane({ active, visited, children }) {
  if (!visited) return null;
  return <div hidden={!active}>{children}</div>;
}

/** A titled run of knobs: dials for the few, sliders next, fields for the tail. */
function KnobSection({ section, state, values, busy, onChange }) {
  const curated = section.controls.filter((c) => !state.missing.has(c.id));
  const covered = CURATED_KEYS;
  const shown = [...curated, ...extraControls(section.prefixes, state.rtcfg, covered)]
    .map((c) => resolveSpec(c, state.ranges));

  if (!shown.length) return null;

  const main = shown.filter((c) => !c.advanced);
  const advanced = shown.filter((c) => c.advanced);

  const render = (c, compact) => (
    <Control
      key={c.id}
      spec={c}
      value={values[c.id]}
      disabled={busy}
      compact={compact}
      onChange={(v) => onChange(c.id, v)}
    />
  );

  return (
    <section className="knobs">
      <h3 className="sec">{section.label}</h3>
      {section.blurb && <p className="panel__blurb">{section.blurb}</p>}
      {runs(main).map((run, i) => (run.hero ? (
        <div className="dials" key={i}>{run.items.map((c) => render(c, false))}</div>
      ) : (
        <Fragment key={i}>{run.items.map((c) => render(c, false))}</Fragment>
      )))}
      {advanced.length > 0 && (
        <details className="sub">
          <summary>Advanced ({advanced.length})</summary>
          {groupByAdv(advanced).map(([name, items]) => (
            <div className="advgroup" key={name}>
              <h4 className="advgroup__title">{name}</h4>
              <div className="grid2">{items.map((c) => render(c, true))}</div>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

function Welcome({ status, note, log, onConnect, onDemo, onClearLog }) {
  const none = !supported.usb && !supported.ble;
  return (
    <div className="welcome">
      {/* Splash: the model, without the view controls that belong to the editor. */}
      <Trackball values={{ sens: 4, sma: 3, glow: 1, brightness: 70 }} tools={false} />
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
            {/* The filtered chooser hides any board that does not enumerate as
                0x11, which is exactly the case for some driver branches. */}
            {supported.usb && (
              <button className="btn btn--ghost" onClick={() => onConnect("usb-all")} disabled={status === "busy"}>
                Not listed? Show every serial port
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

        {/* A connection that fails is exactly when you need the log, and the
            Logs tab is behind a successful connect. So it lives here too. */}
        {log.length > 0 && (
          <details className="console console--welcome" open={status === "idle"}>
            <summary>
              Connection log <span className="console__count">{log.length}</span>
            </summary>
            <div className="logs__body">
              {log.map((l, i) => (
                <div key={i} className={"logrow logrow--" + l.dir}>
                  <span className="logrow__tag">{l.dir === "send" ? "SEND" : "RECEIVE"}</span>
                  <pre className="logrow__text">{l.text || "(no output)"}</pre>
                </div>
              ))}
            </div>
            <div className="console__foot">
              <button className="pill" onClick={onClearLog}>Clear</button>
            </div>
          </details>
        )}

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
