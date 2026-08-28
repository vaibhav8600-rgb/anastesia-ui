import { useCallback, useEffect, useState } from "react";
import { device } from "./device.js";
import {
  unsupported, parseRtcfg, parseKeymap, parseAssignments, parseSurface,
  studioLocked as locked,
} from "./protocol.js";

// Keymap profiles, per-output assignments, and board-level bits.

export const OUTPUTS = [
  { id: "usb", label: "USB" },
  { id: "wireless-1", label: "Bluetooth 1" },
  { id: "wireless-2", label: "Bluetooth 2" },
  { id: "wireless-3", label: "Bluetooth 3" },
  { id: "wireless-4", label: "Bluetooth 4" },
  { id: "wireless-5", label: "Bluetooth 5" },
  { id: "wireless-6", label: "Dongle" },
];

export function Keymap({ live, onNote }) {
  const [slots, setSlots] = useState([]);
  const [assign, setAssign] = useState({});
  const [changed, setChanged] = useState(false);
  const [autoswitch, setAutoswitch] = useState(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    if (!live) {
      setSlots([
        { id: 0, occupied: true, active: true, name: "default", bytes: 812 },
        { id: 1, occupied: true, active: false, name: "mac", bytes: 804 },
        { id: 2, occupied: false, active: false },
      ]);
      setAssign({ usb: "default", "wireless-1": "mac", "wireless-2": null });
      setAutoswitch(1);
      return;
    }
    setBusy(true);
    try {
      const status = await device.send("keymap status");
      if (unsupported(status)) { onNote("Profiles are not available on this firmware."); setSlots([]); return; }
      const k = parseKeymap(status);
      setSlots(k.slots);
      setChanged(k.changed);
      setAssign(parseAssignments(await device.send("keymap assign")));
      const cfg = parseRtcfg(await device.send("rtcfg list"));
      setAutoswitch(cfg["keymap/autoswitch"] ?? null);
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(false);
    }
  }, [live, onNote]);

  useEffect(() => { load(); }, [load]);

  const run = async (cmd, okMsg) => {
    if (!live) { onNote(`Demo mode — would send: ${cmd}`); return; }
    setBusy(true);
    try {
      const res = await device.send(cmd);
      if (locked(res)) { onNote("ZMK Studio is locked. Unlock it first."); return; }
      onNote(okMsg);
      await load();
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!slots.length && !busy) {
    return (
      <>
        <p className="panel__blurb">Keymap profiles stored on the device.</p>
        <p className="empty">No profile support reported.</p>
        <button className="btn" onClick={load}>Refresh</button>
      </>
    );
  }

  return (
    <>
      <p className="panel__blurb">
        Save the live keymap into a slot, then point each connection at the slot it should use.
      </p>

      {changed && <p className="notice">The live keymap has unsaved changes.</p>}

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
              → {s.id}
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
              run(`rtcfg set keymap/autoswitch ${next}`, next ? "Autoswitch on." : "Autoswitch off.");
            }}
          >
            <span className="switch__dot" />
          </button>
        </div>
      )}

      <div className="row row--wrap">
        <button className="btn" onClick={load} disabled={busy}>Refresh</button>
        <button className="btn btn--danger" disabled={busy} onClick={() => run("keymap restore", "Restored the default keymap.")}>
          Reset to default keymap
        </button>
      </div>
    </>
  );
}

export function Board({ live, onNote, rtcfg }) {
  const [info, setInfo] = useState({ version: null, status: null });
  const [surface, setSurface] = useState([]);
  const [bistable, setBistable] = useState(null);
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState("");

  const load = useCallback(async () => {
    if (!live) {
      setInfo({ version: "v0.5.2 (demo)", status: "battery 87%, USB connected" });
      setSurface([{ sensor: 0, quality: 240, max: 361 }, { sensor: 1, quality: 96, max: 361 }]);
      setBistable(0);
      return;
    }
    setBusy(true);
    try {
      const version = await device.send("board version");
      const status = await device.send("board status");
      setInfo({
        version: unsupported(version) ? null : version.trim(),
        status: unsupported(status) ? null : status.trim(),
      });
      const bst = await device.send("rtcfg get bst/default");
      setBistable(unsupported(bst) ? null : Number(bst.match(/(-?\d+)/)?.[1] ?? 0));
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(false);
    }
  }, [live, onNote]);

  useEffect(() => { load(); }, [load]);

  const readSurface = async () => {
    if (!live) { onNote("Demo mode — showing sample sensor quality."); return; }
    setBusy(true);
    try {
      const out = await device.send("sensor surface");
      if (unsupported(out)) { onNote("This board does not report surface quality."); return; }
      setSurface(parseSurface(out));
    } catch (err) { onNote(err.message); } finally { setBusy(false); }
  };

  const exportJson = () => {
    const blob = JSON.stringify({ exported: new Date().toISOString(), rtcfg }, null, 2);
    setJson(blob);
    onNote("Settings written into the box below.");
  };

  const importJson = async () => {
    let parsed;
    try { parsed = JSON.parse(json); } catch { onNote("That is not valid JSON."); return; }
    const entries = Object.entries(parsed.rtcfg ?? parsed);
    if (!entries.length) { onNote("No settings found in that JSON."); return; }
    if (!live) { onNote(`Demo mode — would write ${entries.length} settings.`); return; }
    setBusy(true);
    try {
      for (const [k, v] of entries) {
        if (typeof v === "number") await device.send(`rtcfg set ${k} ${Math.round(v)}`);
      }
      onNote(`Applied ${entries.length} settings.`);
    } catch (err) { onNote(err.message); } finally { setBusy(false); }
  };

  return (
    <>
      <p className="panel__blurb">Board information, sensor health, and a copy of your settings.</p>

      <dl className="facts">
        <dt>Firmware</dt><dd>{info.version ?? "unknown"}</dd>
        <dt>Status</dt><dd>{info.status ?? "unknown"}</dd>
        <dt>Connection</dt><dd>{live ? (device.kind === "ble" ? "Bluetooth" : "USB") : "demo"}</dd>
      </dl>

      <h3 className="sec">Sensor surface quality</h3>
      <p className="ctl__hint">How well each sensor can see the ball. Higher is better.</p>
      {surface.length > 0 ? (
        <ul className="meters">
          {surface.map((s) => {
            const pct = Math.round((s.quality / s.max) * 100);
            const band = pct < 34 ? "low" : pct < 67 ? "mid" : "high";
            return (
              <li key={s.sensor}>
                <span className="meters__label">Sensor {s.sensor}</span>
                <span className="meters__bar">
                  <span className={"meters__fill meters__fill--" + band} style={{ width: pct + "%" }} />
                </span>
                <span className="meters__val">{s.quality}/{s.max}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty">Not measured yet.</p>
      )}
      <button className="btn" onClick={readSurface} disabled={busy}>Measure</button>

      {bistable !== null && (
        <>
          <h3 className="sec">Keyboard mode</h3>
          <div className="row row--wrap">
            {["Windows / Linux", "macOS"].map((label, i) => (
              <button
                key={label}
                className={"pill" + (bistable === i ? " is-active" : "")}
                disabled={busy}
                onClick={async () => {
                  if (!live) { setBistable(i); onNote(`Demo mode — would send: bistable set ${i}`); return; }
                  try { await device.send(`bistable set ${i}`); setBistable(i); onNote(`Switched to ${label}.`); }
                  catch (err) { onNote(err.message); }
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      <h3 className="sec">Back up your settings</h3>
      <textarea
        className="search"
        rows={5}
        value={json}
        onChange={(e) => setJson(e.target.value)}
        placeholder="Export writes your settings here. Paste settings in to restore them."
        aria-label="Settings JSON"
      />
      <div className="row row--wrap">
        <button className="btn" onClick={exportJson}>Export</button>
        <button className="btn" onClick={importJson} disabled={!json.trim() || busy}>Apply</button>
        <button className="btn" onClick={load} disabled={busy}>Refresh</button>
      </div>
      <p className="ctl__hint">
        This covers the runtime parameters. Full storage-partition backup over USB is not built in.
      </p>
    </>
  );
}
