import { useCallback, useEffect, useRef, useState } from "react";
import { device } from "./device.js";
import Loading from "./Loading.jsx";
import Studio from "./Studio.jsx";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEMO_LATENCY_MS = 450;

import {
  unsupported, parseRtcfg, parseKeymap, parseAssignments, parseSurface,
  parseBistableSlot, parseBackup, studioLocked as locked,
} from "./protocol.js";

export const OUTPUTS = [
  { id: "usb", label: "USB" },
  { id: "wireless-1", label: "Bluetooth 1" },
  { id: "wireless-2", label: "Bluetooth 2" },
  { id: "wireless-3", label: "Bluetooth 3" },
  { id: "wireless-4", label: "Bluetooth 4" },
  { id: "wireless-5", label: "Bluetooth 5" },
  { id: "wireless-6", label: "Dongle" },
];

/**
 * Surface quality is out of whatever the sensor reports — 361 on one part,
 * 1000 on another — so the good/warn/bad bands differ per scale.
 */
/** Readings kept per sensor. At one poll a second that is about a minute. */
const SPARK_POINTS = 60;

/**
 * A plain polyline of the last readings — no library, no axes, no gridlines.
 *
 * The line always spans the full width and compresses as the window fills.
 * Right-aligning a partial window instead was defensible — the time scale then
 * never changes — but it draws a stub against the right edge for the first
 * minute, which reads as a broken chart rather than a young one.
 */
function Spark({ values, max }) {
  if (!values || values.length < 2 || !max) return null;
  const W = 100;
  const H = 20;
  const PAD = 2;                       // so peaks are not clipped by the stroke
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;

  // Scaled to the window, not to 0-max. A good surface sits around 700±40, and
  // against a 1000 axis that is a flat line that tells you nothing. Below a 2%
  // spread there is no trend to show, only noise, so it is drawn flat rather
  // than amplified into a mountain range.
  const moving = span >= max * 0.02;
  const step = W / (values.length - 1);
  const y = (v) => (moving ? H - PAD - ((v - lo) / span) * (H - PAD * 2) : H / 2);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <>
      <svg
        className="spark"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Trend of the last ${values.length} readings, ${lo} to ${hi}`}
      >
        <polyline points={points} />
      </svg>
      {/* The vertical scale changes with the data, so it has to be printed or
          the amplitude is unreadable. */}
      <span className="spark__range">
        {moving ? `${lo}–${hi}` : "steady"} over {values.length}
      </span>
    </>
  );
}

/**
 * Surface readings, shared. The roll map wants the same `sensor surface`
 * replies the gauge already asks for, and polling twice for one command would
 * just make both slower — the shell has a 200ms floor between commands.
 *
 * `wantFast` lets a consumer ask for a quicker cadence while it is collecting;
 * one reading a second is fine to watch, but slow to fill a map with.
 */
const feed = new Set();
let fastWanted = 0;

export function onSurface(fn) {
  feed.add(fn);
  return () => feed.delete(fn);
}
export function wantFastSurface() {
  fastWanted++;
  return () => { fastWanted--; };
}

const SURFACE_MS = 1000;
const SURFACE_FAST_MS = 300;

/** Where the bands fall, as fractions of whatever scale the sensor reports. */
function bandCuts(max) {
  return max === 1000 ? [0.25, 0.5] : max === 361 ? [0.3, 0.6] : [0.34, 0.67];
}

export function qualityBand(quality, max) {
  const [warn, good] = bandCuts(max);
  const ratio = quality / max;
  return ratio < warn ? "low" : ratio < good ? "mid" : "high";
}

/** The reading at which this sensor's scale becomes good, in its own units. */
export function goodAt(max) {
  return Math.round(bandCuts(max)[1] * max);
}

/* The band was computed and then thrown away — only a CSS class survived, so a
   colour was the entire verdict. Say it. */
const BAND_WORD = { high: "good", mid: "fair", low: "poor" };

export function Surface({ live, onNote, active = true }) {
  const [sensors, setSensors] = useState([]);
  const [error, setError] = useState(null);
  const [raw, setRaw] = useState(null);

  // A rolling window per sensor. SQUAL is one scalar, so it cannot make an
  // image — but its shape over time is real, and a dropout while you roll the
  // ball is exactly what a single live number hides.
  const history = useRef(new Map());

  /** Record then publish, so every path that reports a value also trends it. */
  const publish = useCallback((list) => {
    for (const s of list) {
      const arr = history.current.get(s.sensor) ?? [];
      arr.push(s.quality);
      if (arr.length > SPARK_POINTS) arr.shift();
      history.current.set(s.sensor, arr);
    }
    setSensors(list);
    for (const fn of feed) fn(list);
  }, []);

  // Reads continuously while the tab is open so you can watch the numbers move
  // as you roll the ball. Between reads the last value simply stays on screen.
  useEffect(() => {
    if (!active) return;
    if (!live) {
      let t;
      const wobble = () => {
        publish([
          { sensor: 0, quality: 690 + Math.round(Math.random() * 90), max: 1000 },
          { sensor: 1, quality: 180 + Math.round(Math.random() * 70), max: 1000 },
        ]);
        t = setTimeout(wobble, 700);
      };
      wobble();
      return () => clearTimeout(t);
    }

    let stop = false;
    let timer;
    const tick = async () => {
      if (stop) return;
      // Yield to the pixel stream as well as to typed commands: a surface
      // reply landing mid-frame corrupts the image.
      if (device.pending || device.streaming) { timer = setTimeout(tick, 200); return; }
      try {
        const out = await device.send("sensor surface");
        if (stop) return;
        if (unsupported(out)) { setError("This board does not report surface quality."); return; }
        const parsed = parseSurface(out);
        // Show what the board actually said rather than an empty card when the
        // wording is not one we recognise.
        setRaw(parsed.length ? null : out.trim());
        publish(parsed);
        setError(null);
      } catch { /* a missed sample just leaves the last one showing */ }
      if (!stop) timer = setTimeout(tick, fastWanted > 0 ? SURFACE_FAST_MS : SURFACE_MS);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [live, active, publish]);

  if (error) return <p className="empty">{error}</p>;

  return (
    <div className="surface">
      <h3 className="surface__title">Surface quality</h3>
      <p className="surface__sub">
        Live tracking quality, and its trend over the last {SPARK_POINTS} readings
      </p>
      {sensors.length > 0 ? (
        <ul className="gauges">
          {sensors.map((s) => (
            <li
              key={s.sensor}
              title={
                s.reportedMax && s.reportedMax !== s.max
                  ? `Board reports ${s.quality}/${s.reportedMax}; its true scale is ${s.max}.`
                  : `Reported by the board as ${s.quality}${s.max ? "/" + s.max : ""}`
              }
            >
              {s.max != null && (
                <span className="sr-only">
                  {`Sensor ${s.sensor}: ${BAND_WORD[qualityBand(s.quality, s.max)]}. `}
                  {`${s.quality} of ${s.max}; good from ${goodAt(s.max)}.`}
                </span>
              )}
              <div className="gauges__head">
                <span className="gauges__name">Sensor #{s.sensor}</span>
                {s.max != null && (
                  <span className={"gauges__band gauges__band--" + qualityBand(s.quality, s.max)}>
                    {BAND_WORD[qualityBand(s.quality, s.max)]}
                  </span>
                )}
                <span className="gauges__val">
                  {s.max ? `${s.quality}/${s.max}` : s.quality}
                  {s.max != null && <em className="gauges__rule">good from {goodAt(s.max)}</em>}
                </span>
              </div>
              {s.max != null && (
                <>
                  <div className="gauges__track">
                    <div
                      className={"gauges__fill gauges__fill--" + qualityBand(s.quality, s.max)}
                      style={{ width: Math.min(100, (s.quality / s.max) * 100) + "%" }}
                    />
                  </div>
                  <Spark values={history.current.get(s.sensor)} max={s.max} />
                </>
              )}
            </li>
          ))}
        </ul>
      ) : raw ? (
        <pre className="surface__raw">{raw}</pre>
      ) : (
        <Loading label="Reading surface quality…" />
      )}
    </div>
  );
}

export function Keymap({ live, onNote, onKeyLabels, onWheelLabels }) {
  const [slots, setSlots] = useState([]);
  const [assign, setAssign] = useState({});
  const [changed, setChanged] = useState(false);
  const [autoswitch, setAutoswitch] = useState(null);
  const [bistable, setBistable] = useState(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    if (!live) {
      // Demo answers instantly, which a device never does: a real read is a
      // handshake plus commands behind a 200ms floor. Pretending otherwise
      // meant demo never rendered a loading state, so nothing exercised one.
      setBusy(true);
      await sleep(DEMO_LATENCY_MS);
      setSlots([
        { id: 0, occupied: true, active: true, name: "default", bytes: 812 },
        { id: 1, occupied: true, active: false, name: "mac", bytes: 804 },
        { id: 2, occupied: false, active: false },
      ]);
      setAssign({ usb: "default", "wireless-1": "mac", "wireless-2": null });
      setAutoswitch(1);
      setBistable(0);
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      // `keymap status` answers with nothing at all until the slots subsystem
      // has been initialised — the shell registers `init` for exactly that, and
      // a board that has never had it run reports no profiles while `keymap
      // assign` happily names one. So an empty reply is not "no support", it is
      // "not started yet": run init once and ask again.
      let status = await device.send("keymap status");
      let started = true;
      if (!unsupported(status) && !status.trim()) {
        started = !unsupported(await device.send("keymap init"));
        if (started) status = await device.send("keymap status");
      }
      if (unsupported(status)) { onNote("Profiles are not available on this firmware."); setSlots([]); return; }
      if (!status.trim()) {
        // Three different silences, and they mean different things.
        onNote(started
          ? "The board started its slots subsystem but still lists no profiles."
          : "This firmware lists no profiles and has no way to start them.");
        setSlots([]);
        return;
      }
      const k = parseKeymap(status);
      setSlots(k.slots);
      setChanged(k.changed);
      setAssign(parseAssignments(await device.send("keymap assign")));
      const cfg = parseRtcfg(await device.send("rtcfg list"));
      setAutoswitch(cfg["keymap/autoswitch"] ?? null);
      // `bistable set` changes the slot in use right now; bst/default is only
      // what the board boots into. Reading one and writing the other made this
      // switch snap back to its old value on every refresh.
      setBistable(parseBistableSlot(await device.send("bistable slot")));
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(false);
    }
  }, [live, onNote]);

  useEffect(() => { load(); }, [load]);

  const run = async (cmd, okMsg, reload = true) => {
    if (!live) { onNote(`Demo mode — would send: ${cmd}`); return; }
    setBusy(true);
    try {
      const res = await device.send(cmd);
      if (locked(res)) { onNote("ZMK Studio is locked. Unlock it first."); return; }
      onNote(okMsg);
      if (reload) await load();
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!slots.length) {
    return (
      <>
        <p className="panel__blurb">Keymap profiles stored on the device.</p>
        {busy
          ? <Loading label="Reading profiles…" />
          : <p className="empty">No profile support reported.</p>}
        <button className="btn" onClick={load} disabled={busy}>Refresh</button>
      </>
    );
  }

  return (
    <>
      {/* The editor first: bindings are what people open this tab for, and
          profiles are the housekeeping around them. */}
      <Studio onNote={onNote} onKeyLabels={onKeyLabels} onWheelLabels={onWheelLabels} />

      <p className="panel__blurb">
        Save the live keymap into a slot, then point each connection at the slot it should use.
      </p>

      {/* The board says "your current keymap has changes" whenever the live
          keymap differs from the last saved slot — which, with no slot saved,
          is always and forever. Comparing against a profile that does not
          exist is not information, so it waits until there is one. */}
      {changed && slots.some((s) => s.occupied) && (
        <p className="notice">The live keymap differs from your saved profiles.</p>
      )}

      <h3 className="sec">Profiles</h3>
      <ul className="slots">
        {slots.map((s) => (
          <li key={s.id} className={s.active ? "is-active" : ""}>
            <span className="slots__id">Slot {s.id}</span>
            <span className="slots__name">
              {s.occupied ? (s.name ?? "unnamed") : "empty"}
              {s.bytes ? <em> · {s.bytes} B</em> : null}
            </span>
            <span className="row">
              {!s.active && s.occupied && (
                <button className="pill" disabled={busy} onClick={() => run(`keymap activate ${s.id}`, `Activated slot ${s.id}.`)}>
                  Activate
                </button>
              )}
              {s.occupied && (
                <button className="pill pill--danger" disabled={busy} onClick={() => run(`keymap destroy ${s.id}`, `Deleted slot ${s.id}.`)}>
                  Delete
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="ctl">
        <label className="ctl__label" htmlFor="pname">Save current keymap as</label>
        <div className="row row--wrap">
          <input
            id="pname"
            className="search"
            value={name}
            placeholder="profile name"
            onChange={(e) => setName(e.target.value)}
          />
          {slots.map((s) => (
            <button
              key={s.id}
              className="pill"
              disabled={busy || !name.trim()}
              onClick={() => run(
                `keymap ${s.occupied ? "overwrite" : "save"} ${s.id} ${name.trim().toLowerCase()}`,
                `Wrote “${name.trim()}” to slot ${s.id}.`,
              )}
            >
              Slot {s.id}
            </button>
          ))}
        </div>
      </div>

      <h3 className="sec">Which profile each connection uses</h3>
      <ul className="assigns">
        {OUTPUTS.map((o) => (
          <li key={o.id}>
            <span>{o.label}</span>
            <select
              className="search search--slim"
              aria-label={`Profile for ${o.label}`}
              value={assign[o.id] ?? ""}
              onChange={(e) => run(
                e.target.value ? `keymap assign ${o.id} ${e.target.value}` : `keymap assign ${o.id}`,
                `${o.label} → ${e.target.value || "not assigned"}.`,
              )}
            >
              <option value="">Not assigned</option>
              {slots.filter((s) => s.occupied && s.name).map((s) => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
          </li>
        ))}
      </ul>

      {autoswitch !== null && (
        <div className="ctl ctl--inline">
          <label className="ctl__label" htmlFor="autosw">Switch profile automatically</label>
          <button
            id="autosw"
            role="switch"
            aria-checked={autoswitch === 1}
            className="switch"
            disabled={busy}
            onClick={() => {
              const next = autoswitch === 1 ? 0 : 1;
              setAutoswitch(next);
              run(`rtcfg set keymap/autoswitch ${next}`, next ? "Autoswitch on." : "Autoswitch off.", false);
            }}
          >
            <span className="switch__dot" />
          </button>
        </div>
      )}

      {bistable !== null && (
        <>
          <h3 className="sec">Keyboard mode</h3>
          <p className="ctl__hint">Active now. The slot the board starts in is under Sensor(s) → Advanced scaling.</p>
          <div className="row row--wrap">
            {["Windows / Linux", "macOS"].map((label, i) => (
              <button
                key={label}
                className={"pill" + (bistable === i ? " is-active" : "")}
                disabled={busy}
                onClick={() => { setBistable(i); run(`bistable set ${i}`, `Switched to ${label}.`, false); }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="actions">
        <button className="btn" onClick={load} disabled={busy}>Refresh</button>
        <span className="actions__gap" />
        <button className="btn btn--danger" disabled={busy} onClick={() => run("keymap restore", "Restored the default keymap.")}>
          Reset to default keymap
        </button>
      </div>

    </>
  );
}

export function ImportExport({ live, onNote, rtcfg, firmware }) {
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);

  /** Read the device fresh; the prop is a snapshot from connection time. */
  const settingsBlob = async () => {
    let current = rtcfg;
    if (live) {
      try { current = parseRtcfg(await device.send("rtcfg list")); }
      catch { /* fall back to the snapshot rather than exporting nothing */ }
    }
    return JSON.stringify({
      app: "anastasia-ui",
      exported: new Date().toISOString(),
      firmware: firmware ?? null,
      rtcfg: current,
    }, null, 2);
  };

  const read = async () => {
    setBusy(true);
    try { setJson(await settingsBlob()); onNote("Settings read into the box below."); }
    finally { setBusy(false); }
  };

  const download = async () => {
    const blob = new Blob([await settingsBlob()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `anastasia-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    onNote("Settings file downloaded.");
  };

  const openFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      JSON.parse(text);            // fail here rather than halfway through applying
      setJson(text);
      onNote(`Loaded ${file.name}. Review it, then Apply.`);
    } catch {
      onNote(`${file.name} is not valid JSON.`);
    }
  };

  const entriesOf = (text) => {
    const parsed = JSON.parse(text);
    return Object.entries(parsed.rtcfg ?? parsed)
      .filter(([k, v]) => typeof v === "number" && /^[a-z0-9_]+(\/[a-z0-9_]+)+$/i.test(k));
  };

  const apply = async () => {
    let entries;
    try { entries = entriesOf(json); } catch { onNote("That is not valid JSON."); return; }
    if (!entries.length) { onNote("No settings found in that JSON."); return; }
    if (!live) { onNote(`Demo mode — would write ${entries.length} settings.`); return; }
    setBusy(true);
    let done = 0;
    try {
      for (const [k, v] of entries) {
        await device.send(`rtcfg set ${k} ${Math.round(v)}`);
        done++;
      }
      onNote(`Applied ${done} settings. Reconnect to see them in the panels.`);
    } catch (err) {
      onNote(`Stopped after ${done} of ${entries.length}: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  let count = null;
  try { count = json.trim() ? entriesOf(json).length : null; } catch { count = null; }

  return (
    <>
      <p className="panel__blurb">
        Take a copy of every runtime parameter, or push a saved copy back onto the device.
      </p>

      <h3 className="sec">Export</h3>
      <div className="row row--wrap">
        <button className="btn" onClick={read} disabled={busy}>Read current</button>
        <button className="btn btn--primary" onClick={download} disabled={busy}>Download .json</button>
      </div>

      <h3 className="sec">Import</h3>
      <div className="row row--wrap">
        <label className="btn btn--file">
          Choose .json file
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = ""; }}
          />
        </label>
        <button className="btn btn--primary" onClick={apply} disabled={!json.trim() || busy}>
          {count === null ? "Apply to device" : `Apply ${count} settings`}
        </button>
      </div>

      <textarea
        className="search"
        rows={10}
        value={json}
        onChange={(e) => setJson(e.target.value)}
        placeholder="Read current, or choose a file, to see settings here. You can also paste them."
        aria-label="Settings JSON"
      />

      <StorageBackup live={live} onNote={onNote} />
    </>
  );
}

/** Trigger a real download. Appending without clicking saves nothing. */
function saveFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * The whole storage partition, not just the runtime parameters: keymaps,
 * profiles and effects included. Every line carries a CRC-8, and both
 * directions verify them — a file that will not verify is never written to
 * flash.
 */
function StorageBackup({ live, onNote }) {
  const [busy, setBusy] = useState(null);      // 'backup' | 'restore' | 'erase'
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState(null);      // { name, text, check }
  const [confirm, setConfirm] = useState("");
  const cancelled = useRef(false);

  const backup = async () => {
    if (!live) { onNote("Demo mode — connect a device to back it up."); return; }
    setBusy("backup");
    try {
      onNote("Reading the storage partition…");
      // Tens of kilobytes of hex arrive a line at a time, far past a normal
      // command's patience.
      const out = await device.send("board backup", { timeout: 120000 });
      if (locked(out)) { onNote("ZMK Studio is locked. Unlock it, then back up."); return; }
      const b = parseBackup(out);
      if (!b.ok) {
        for (const e of b.errors.slice(0, 3)) onNote(e);
        throw new Error(b.errors[0] ?? "The board did not return a usable backup.");
      }
      // The .bak is the restorable artefact; the .dat is the raw image, for
      // anyone who wants to look inside it.
      const between = out.slice(out.indexOf("BACKUP START"), out.indexOf("BACKUP END") + 10);
      saveFile(`anastasia-backup-${stamp()}.bak`, new Blob([between], { type: "text/plain" }));
      saveFile(`anastasia-backup-${stamp()}.dat`, new Blob([b.bytes], { type: "application/octet-stream" }));
      onNote(`Backed up ${b.bytes.length} bytes in ${b.lines} chunks — every checksum verified.`);
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(null);
    }
  };

  const openBackup = async (f) => {
    if (!f) return;
    const text = await f.text();
    const check = parseBackup(text);
    setFile({ name: f.name, text, check });
    onNote(check.ok
      ? `${f.name}: ${check.lines} chunks, ${check.bytes.length} bytes, all checksums good.`
      : `${f.name}: ${check.errors[0]}`);
  };

  const restore = async () => {
    if (!file?.check.ok) return;
    if (!live) { onNote(`Demo mode — would restore ${file.check.lines} chunks.`); return; }
    setBusy("restore");
    setProgress(0);
    cancelled.current = false;
    const { startLine, dataLines } = file.check;
    try {
      const first = await device.send(`board restore ${startLine}`);
      if (locked(first)) { onNote("ZMK Studio is locked. Unlock it, then restore."); return; }
      if (/invalid|not in progress/i.test(first)) throw new Error(`The board refused the header: ${first}`);

      for (let i = 0; i < dataLines.length; i++) {
        if (cancelled.current) throw new Error(`Stopped after ${i} of ${dataLines.length} chunks. The partition is half-written — restore again before using the device.`);
        const res = await device.send(`board restore ${dataLines[i]}`);
        if (locked(res)) throw new Error("ZMK Studio locked partway through. Unlock it and restore again.");
        if (/invalid|mismatch|unsuccessful/i.test(res)) throw new Error(`Chunk ${i + 1} rejected: ${res}`);
        if (!res.trim()) throw new Error(`Chunk ${i + 1}: the board said nothing back.`);
        setProgress(Math.round(((i + 1) / dataLines.length) * 100));
      }
      await device.send("board restore BACKUP END");
      setProgress(100);
      onNote("Restored. The device reboots now.");
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(null);
    }
  };

  const erase = async () => {
    if (!live) { onNote("Demo mode — nothing was erased."); return; }
    setBusy("erase");
    try {
      const out = await device.send("board erase", { timeout: 30000 });
      if (locked(out)) { onNote("ZMK Studio is locked. Unlock it first."); return; }
      onNote("Storage erased. The device reboots to defaults.");
      setConfirm("");
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(null);
    }
  };

  const check = file?.check;

  return (
    <>
      <h3 className="sec">Full device backup</h3>
      <p className="ctl__hint">
        The whole storage partition — keymaps, profiles and effects, not just the
        parameters above. Needs USB and an unlocked ZMK Studio.
      </p>
      <div className="row row--wrap">
        <button className="btn" onClick={backup} disabled={!!busy}>
          {busy === "backup" ? "Reading…" : "Download backup"}
        </button>
        <label className="btn btn--file">
          Choose .bak file
          <input
            type="file"
            accept=".bak,text/plain"
            onChange={(e) => { openBackup(e.target.files?.[0]); e.target.value = ""; }}
          />
        </label>
      </div>

      {check && (
        <div className={check.ok ? "notice notice--ok" : "notice"}>
          <p>
            <strong>{file.name}</strong>{" "}
            {check.ok
              ? `verified: ${check.lines} chunks, ${check.bytes.length} bytes.`
              : check.errors[0]}
          </p>
          {check.ok && (
            <button className="btn btn--danger" onClick={restore} disabled={!!busy}>
              {busy === "restore" ? `Restoring ${progress}%` : "Write it to the device"}
            </button>
          )}
        </div>
      )}

      {busy === "restore" && (
        <>
          <div className="gauges__track">
            <div className="gauges__fill gauges__fill--high" style={{ width: progress + "%" }} />
          </div>
          <button className="pill" onClick={() => { cancelled.current = true; }}>Stop</button>
        </>
      )}

      <h3 className="sec">Erase everything</h3>
      <p className="ctl__hint">
        Wipes the storage partition and reboots to firmware defaults. Keymaps,
        profiles and effects go with it. Back up first.
      </p>
      <div className="row row--wrap">
        <input
          className="search search--slim"
          value={confirm}
          placeholder="type ERASE"
          aria-label="Type ERASE to confirm"
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button
          className="btn btn--danger"
          disabled={confirm.trim().toUpperCase() !== "ERASE" || !!busy}
          onClick={erase}
        >
          {busy === "erase" ? "Erasing…" : "Erase device"}
        </button>
      </div>
    </>
  );
}
