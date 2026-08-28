import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { device, supported } from "./device.js";
import { groups, allControls, readAll } from "./settings.js";
import Trackball from "./Trackball.jsx";
import Control from "./Control.jsx";

const DEMO_STATE = {
  rtcfg: {
    "accel/dz_enable": 1, "accel/dz_thres": 6, "accel/dz_cooldown": 120,
    "p2sm/frame_sync": 0, "p2sm/twist_thres": 40, "p2sm/twist_deb": 25,
    "p2sm/ema_alpha": 45, "p2sm/scroll_dis_ptr": 1, "p2sm/feedback_en": 1,
    "p2sm/fb_dur": 12, "p2sm/fb_thres": 30,
    "argb/brt": 60, "argb/tick": 30, "argb/bw1": 25, "argb/bc1": 10,
  },
  sens: 3.2, plane: 0, sma: 4, rrl: 0,
  twist: 1, twistSens: 2.5, argb: 1,
  missing: new Set(),
};

export default function App() {
  // ?demo opens the cockpit with sample values — handy for a look around,
  // and for screenshots.
  const [status, setStatus] = useState(() =>
    new URLSearchParams(location.search).has("demo") ? "demo" : "idle");
  const [note, setNote] = useState(null);
  const [state, setState] = useState(null);
  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState(() => new Set());
  const [tab, setTab] = useState("feel");
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
    if (status !== "ready") { setDirty(new Set()); return; }
    setStatus("busy");
    setNote("Saving…");
    try {
      for (const id of dirty) {
        const spec = allControls.find((c) => c.id === id);
        if (spec) await spec.write(values[id]);
      }
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

  // What the 3D preview reads. Names here are the scene's vocabulary, not the
  // firmware's, so the scene stays independent of the settings table.
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

  const group = groups.find((g) => g.id === tab);

  return (
    <div className="app">
      <header className="bar">
        <h1 className="bar__title">Anastesia</h1>
        <span className={"chip chip--" + (status === "demo" ? "demo" : "live")}>
          {status === "demo" ? "Demo" : device.kind === "ble" ? "Bluetooth" : "USB"}
        </span>
        <div className="bar__spacer" />
        {dirty.size > 0 && (
          <button className="btn btn--ghost" onClick={revert}>Revert</button>
        )}
        <button className="btn btn--primary" onClick={save} disabled={dirty.size === 0 || status === "busy"}>
          {dirty.size > 0 ? `Save ${dirty.size}` : "Saved"}
        </button>
        <button className="btn btn--ghost" onClick={disconnect}>
          {status === "demo" ? "Exit" : "Disconnect"}
        </button>
      </header>

      <main className="stage">
        <section className="stage__view">
          <Trackball values={scene} onScrollTick={onScrollTick} />
          <p className="stage__caption">
            Drag the ball to feel your settings.
            <span className="ticker" ref={scrollHint} data-live="0" />
          </p>
        </section>

        <section className="stage__panel">
          <nav className="tabs" role="tablist" aria-label="Settings groups">
            {groups.map((g) => (
              <button
                key={g.id}
                role="tab"
                aria-selected={tab === g.id}
                className={"tab" + (tab === g.id ? " is-active" : "")}
                onClick={() => setTab(g.id)}
              >
                {g.label}
              </button>
            ))}
            <button
              role="tab"
              aria-selected={tab === "expert"}
              className={"tab" + (tab === "expert" ? " is-active" : "")}
              onClick={() => setTab("expert")}
            >
              Expert
            </button>
          </nav>

          <div className="panel" role="tabpanel">
            {group ? (
              <>
                <p className="panel__blurb">{group.blurb}</p>
                {group.controls
                  .filter((c) => !state.missing.has(c.id))
                  .map((c) => (
                    <Control
                      key={c.id}
                      spec={c}
                      value={values[c.id]}
                      disabled={status === "busy"}
                      onChange={(v) => change(c.id, v)}
                    />
                  ))}
              </>
            ) : (
              <Expert rtcfg={state.rtcfg} live={status === "ready"} onNote={setNote} />
            )}
          </div>
        </section>
      </main>

      {note && <p className="toast" role="status">{note}</p>}

      <details className="console">
        <summary>Device log ({log.length})</summary>
        <pre>{log.map((l) => `${l.dir === "send" ? "›" : "‹"} ${l.text}`).join("\n")}</pre>
      </details>
    </div>
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
  const keys = Object.keys(rtcfg).filter((k) => k.includes(q.toLowerCase())).sort();

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
      <p className="panel__blurb">Raw firmware parameters. Changes here apply immediately.</p>
      <input
        className="search"
        type="search"
        placeholder="Filter parameters"
        aria-label="Filter parameters"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="raw">
        {keys.map((k) => (
          <li key={k}>
            <code>{k}</code>
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
