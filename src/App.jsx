import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { device, supported } from "./device.js";
import { groups, allControls, readAll, RTCFG_HELP } from "./settings.js";
import Trackball, { hasWebGL } from "./Trackball.jsx";
import Control from "./Control.jsx";
import Curves from "./Curves.jsx";
import Effects from "./Effects.jsx";
import { Keymap, Board } from "./Board.jsx";
import Status from "./Status.jsx";

const DEMO_RTCFG = {
  "accel/dz_enable": 1, "accel/dz_thres": 6, "accel/dz_cooldown": 120, "accel/dz_before": 0,
  "p2sm/frame_sync": 0, "p2sm/steady_thres": 12, "p2sm/steady_cd": 150,
  "p2sm/twist_thres": 40, "p2sm/twist_deb": 25, "p2sm/twist_ttl": 120,
  "p2sm/ema_alpha": 45, "p2sm/scroll_dis_ptr": 1, "p2sm/ptr_after_scroll": 200,
  "p2sm/twist_global_en": 1, "p2sm/dy_mag_mul": 3, "p2sm/dy_mag_div": 2,
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

const DEMO_STATE = {
  rtcfg: DEMO_RTCFG,
  sens: 3.2, plane: 0, sma: 4, rrl: 0,
  twist: 1, twistSens: 2.5, twistReverse: 0, argb: 1,
  missing: new Set(),
  status: "demo",
};

const EXTRA_TABS = [
  { id: "curves", label: "Curves" },
  { id: "effects", label: "Effects" },
  { id: "keymap", label: "Keymap" },
  { id: "board", label: "Board" },
  { id: "expert", label: "Expert" },
];

export default function App() {
  // ?demo opens the cockpit with sample values — handy for a look around.
  const [status, setStatus] = useState(() =>
    new URLSearchParams(location.search).has("demo") ? "demo" : "idle");
  const [note, setNote] = useState(null);
  const [state, setState] = useState(null);
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState(() => new Set());
  const [tab, setTab] = useState("feel");
  // Panels talk to the device when they mount. Remounting on every tab switch
  // meant paying for those round trips again, so a visited tab stays mounted
  // and is only hidden.
  const [visited, setVisited] = useState(() => new Set(["feel"]));
  const [log, setLog] = useState([]);
  const scrollHint = useRef(null);

  useEffect(() => device.onLog((e) => setLog((l) => [...l.slice(-120), e])), []);

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
      // Expert and the settings export both read state.rtcfg, so it has to
      // follow what we just wrote or they show stale numbers.
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
  // Hide a whole group when this firmware carries none of its keys.
  const visibleGroups = groups.filter(
    (g) => !g.optional || g.controls.some((c) => !state.missing.has(c.id)),
  );
  return (
    <div className="app">
      <header className="bar">
        <span className="brand">
          <strong>Anastesia</strong>
          <em>by Vaibhav Rajput</em>
        </span>
        {!live && <span className="chip">Demo</span>}
        <div className="bar__spacer" />
        <Status live={live} />
        {dirty.size > 0 && <button className="btn btn--ghost" onClick={revert}>Revert</button>}
        <button className="btn btn--primary" onClick={save} disabled={dirty.size === 0 || status === "busy"}>
          {dirty.size > 0 ? `Save ${dirty.size}` : "Saved"}
        </button>
        <button className="btn btn--ghost" onClick={disconnect}>
          {live ? "Disconnect" : "Exit"}
        </button>
      </header>

      <main className="stage">
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
          <nav className="tabs" role="tablist" aria-label="Settings groups">
            {[...visibleGroups, ...EXTRA_TABS].map((g) => (
              <button
                key={g.id}
                role="tab"
                aria-selected={tab === g.id}
                className={"tab" + (tab === g.id ? " is-active" : "")}
                onClick={() => { setTab(g.id); setVisited((v) => new Set(v).add(g.id)); }}
              >
                {g.label}
              </button>
            ))}
          </nav>

          <div className="panel" role="tabpanel">
            {visibleGroups.map((g) => (
              <Pane key={g.id} active={tab === g.id} visited={visited.has(g.id)}>
                <KnobGroup
                  group={g}
                  state={state}
                  values={values}
                  busy={status === "busy"}
                  onChange={change}
                />
              </Pane>
            ))}
            <Pane active={tab === "curves"} visited={visited.has("curves")}>
              <Curves live={live} onNote={setNote} />
            </Pane>
            <Pane active={tab === "effects"} visited={visited.has("effects")}>
              <Effects live={live} onNote={setNote} />
            </Pane>
            <Pane active={tab === "keymap"} visited={visited.has("keymap")}>
              <Keymap live={live} onNote={setNote} />
            </Pane>
            <Pane active={tab === "board"} visited={visited.has("board")}>
              <Board live={live} onNote={setNote} rtcfg={state.rtcfg} />
            </Pane>
            <Pane active={tab === "expert"} visited={visited.has("expert")}>
              <Expert rtcfg={state.rtcfg} live={live} onNote={setNote} />
            </Pane>
          </div>
        </section>
      </main>

      {note && <p className="toast" role="status">{note}</p>}

      <DeviceLog log={log} onClear={() => setLog([])} />
    </div>
  );
}

/** Mounted once visited, hidden rather than torn down when you switch away. */
function Pane({ active, visited, children }) {
  if (!visited) return null;
  return <div hidden={!active}>{children}</div>;
}

/** One line per exchange: time, direction, text — sent in green, replies dim. */
function DeviceLog({ log, onClear }) {
  const body = useRef(null);
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  return (
    <details className="console">
      <summary>
        Device log <span className="console__count">{log.length}</span>
      </summary>
      <div className="console__body" ref={body}>
        {log.length === 0 && <p className="empty">Nothing sent yet.</p>}
        {log.map((l, i) => (
          <div key={i} className={"logline logline--" + l.dir}>
            <time>{new Date(l.at).toLocaleTimeString()}</time>
            <span className="logline__arrow">{l.dir === "send" ? "›" : "‹"}</span>
            <span className="logline__text">{l.text || "(no output)"}</span>
          </div>
        ))}
      </div>
      <div className="console__foot">
        <button className="pill" onClick={onClear}>Clear</button>
      </div>
    </details>
  );
}

/** The handful of everyday knobs, with the rest folded away behind a summary. */
function KnobGroup({ group, state, values, busy, onChange }) {
  const shown = group.controls.filter((c) => !state.missing.has(c.id));
  const main = shown.filter((c) => !c.advanced);
  const advanced = shown.filter((c) => c.advanced);

  const render = (c) => (
    <Control
      key={c.id}
      spec={c}
      value={values[c.id]}
      disabled={busy}
      onChange={(v) => onChange(c.id, v)}
    />
  );

  return (
    <>
      <p className="panel__blurb">{group.blurb}</p>
      {main.map(render)}
      {advanced.length > 0 && (
        <details className="sub">
          <summary>Advanced ({advanced.length})</summary>
          {advanced.map(render)}
        </details>
      )}
    </>
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

/** Every runtime parameter the firmware exposes, flat and searchable. */
function Expert({ rtcfg, live, onNote }) {
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
        Every runtime parameter on the device, including any this build has no
        friendly control for. Changes here apply immediately.
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
        {keys.map((k) => (
          <li key={k}>
            <span className="raw__key">
              <code>{k}</code>
              {RTCFG_HELP[k] && <span className="raw__hint">{RTCFG_HELP[k]}</span>}
            </span>
            <input
              type="number"
              defaultValue={rtcfg[k]}
              aria-label={k}
              onBlur={(e) => Number(e.target.value) !== rtcfg[k] && set(k, e.target.value)}
            />
          </li>
        ))}
        {keys.length === 0 && <li className="raw__empty">Nothing matches “{q}”.</li>}
      </ul>
    </>
  );
}
