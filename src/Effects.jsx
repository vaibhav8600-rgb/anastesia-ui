import { useCallback, useEffect, useState } from "react";
import { device } from "./device.js";
import {
  unsupported, EASINGS, parseEventList as parseList, parseEvent, validateEvent,
} from "./protocol.js";

// Per-event RGB and vibration. Events cover idle, USB connect/disconnect,
// each Bluetooth profile, battery warnings and every keymap layer.

const ANIMS = { solid: "Solid", blink: "Blink", breathe: "Breathe", flash: "Flash" };

// Only layer events animate continuously; the rest are one-shot flashes.
const animsFor = (name) => (name.startsWith("layer") ? Object.keys(ANIMS) : ["flash"]);

const hex = ({ r, g, b }) =>
  "#" + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");

const rgb = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

const DEMO = [
  { name: "idle", label: "Idle" },
  { name: "usb-conn", label: "USB connected" },
  { name: "usb-disconn", label: "USB disconnected" },
  ...[1, 2, 3, 4, 5].map((n) => ({ name: `ble-profile ${n}`, label: `Bluetooth profile ${n}` })),
  { name: "no-endpoint", label: "No endpoint" },
  { name: "batt-warn 1", label: "Battery warning 1" },
  { name: "batt-crit 1", label: "Battery critical 1" },
  { name: "layer 0", label: null },
  { name: "layer 1", label: null },
];

const demoEvent = (name, i) => ({
  name,
  label: DEMO.find((d) => d.name === name)?.label ?? null,
  anim: name.startsWith("layer") ? "solid" : "flash",
  colors: [rgb(["#7cd4ff", "#63e6a0", "#ffa06a", "#ff6b8a", "#c58cff"][i % 5])],
  blinkOnMs: 100, blinkOffMs: 100, breatheDurMs: 1000,
  flashDurMs: 200, flashEaseInMs: 40, flashEaseInFn: "quad-in",
  flashEaseOutMs: 60, flashEaseOutFn: "quad-out", feedback: [],
});

export default function Effects({ live, onNote }) {
  const [events, setEvents] = useState([]);
  const [sel, setSel] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [supportsRgb, setSupportsRgb] = useState(true);
  const [note, setLocal] = useState(null);

  const load = useCallback(async () => {
    if (!live) {
      const list = DEMO.map((d, i) => demoEvent(d.name, i));
      setEvents(list);
      setSel((s) => s ?? list[3].name);   // land on a Bluetooth profile
      return;
    }
    setBusy(true);
    try {
      const support = await device.send("board rgb");
      setSupportsRgb(support.toLowerCase().includes("yes"));

      const listing = await device.send("argb list");
      if (unsupported(listing)) { onNote("Effects are not available on this firmware."); setEvents([]); return; }

      const names = parseList(listing);
      const out = [];
      for (const { name } of names) {
        try {
          out.push(parseEvent(await device.send(`argb evt ${name} show`), name));
        } catch { /* one unreadable event should not sink the list */ }
      }
      setEvents(out);
      setSel((s) => (s && out.some((e) => e.name === s) ? s : out[0]?.name ?? null));
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(false);
    }
  }, [live, onNote]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const found = events.find((e) => e.name === sel);
    setDraft(found ? { ...found, colors: found.colors.map((c) => ({ ...c })) } : null);
    setLocal(null);
  }, [sel, events]);

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    const err = validateEvent(draft);
    if (err) { setLocal(err); return; }
    const n = draft.name;
    const cmds = [`argb evt ${n} anim ${draft.anim}`];

    if (draft.colors.length === 1) {
      const c = draft.colors[0];
      cmds.push(`argb evt ${n} color ${c.r} ${c.g} ${c.b}`);
    } else {
      draft.colors.forEach((c, i) => cmds.push(`argb evt ${n} color ${i} ${c.r} ${c.g} ${c.b}`));
    }
    if (draft.anim === "blink") cmds.push(`argb evt ${n} blink ${draft.blinkOnMs} ${draft.blinkOffMs}`);
    if (draft.anim === "breathe") cmds.push(`argb evt ${n} breathe ${draft.breatheDurMs}`);
    if (draft.anim === "flash") {
      cmds.push(`argb evt ${n} flash ${draft.flashDurMs}`);
      cmds.push(`argb evt ${n} flash-ease-in ${draft.flashEaseInMs} ${draft.flashEaseInFn}`);
      cmds.push(`argb evt ${n} flash-ease-out ${draft.flashEaseOutMs} ${draft.flashEaseOutFn}`);
    }
    if (draft.feedback.length) cmds.push(`argb evt ${n} feedback ${draft.feedback.join(" ")}`);

    if (!live) {
      onNote(`Demo mode — ${cmds.length} commands would be sent.`);
      setEvents((es) => es.map((e) => (e.name === n ? draft : e)));
      return;
    }
    setBusy(true);
    try {
      for (const c of cmds) await device.send(c);
      setEvents((es) => es.map((e) => (e.name === n ? draft : e)));
      onNote(`Saved “${draft.label ?? n}”.`);
    } catch (err2) {
      onNote(err2.message);
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    if (!live) { onNote(`Demo mode — would send: argb evt ${draft.name} show`); return; }
    try { await device.send(`argb evt ${draft.name} show`); onNote("Triggered on the device."); }
    catch (err) { onNote(err.message); }
  };

  const override = async () => {
    try {
      await device.send("board rgb override");
      setSupportsRgb(true);
      onNote("RGB override applied. Restart the board for it to take effect.");
    } catch (err) { onNote(err.message); }
  };

  if (!events.length) {
    return (
      <>
        <p className="panel__blurb">Colour and vibration for each device event.</p>
        <p className="empty">{busy ? "Reading effects…" : "No effects reported by this board."}</p>
        <button className="btn" onClick={load} disabled={busy}>Refresh</button>
      </>
    );
  }

  const allowed = draft ? animsFor(draft.name) : [];

  return (
    <>
      <p className="panel__blurb">
        Pick an event, then give it a colour. Bluetooth profiles are in here, so each
        one can light up differently.
      </p>

      {live && !supportsRgb && (
        <div className="notice">
          <p>This board does not report RGB support.</p>
          <button className="btn" onClick={override}>Force enable</button>
        </div>
      )}

      <label className="ctl__label" htmlFor="evt">Event</label>
      <select id="evt" className="search" value={sel ?? ""} onChange={(e) => setSel(e.target.value)}>
        {events.map((e) => (
          <option key={e.name} value={e.name}>
            {e.label ? `${e.label} — ${e.name}` : e.name}
          </option>
        ))}
      </select>

      {draft && (
        <>
          <div className="swatches">
            {draft.colors.map((c, i) => (
              <div key={i} className="swatch">
                <input
                  type="color"
                  aria-label={`Colour ${i + 1}`}
                  value={hex(c)}
                  onChange={(e) => {
                    const next = draft.colors.map((x, k) => (k === i ? rgb(e.target.value) : x));
                    patch({ colors: next });
                  }}
                />
                <span>{hex(c)}</span>
              </div>
            ))}
          </div>

          <div className="row row--wrap">
            <button
              className="btn"
              disabled={draft.colors.length >= 4 || draft.anim === "solid"}
              onClick={() => patch({ colors: [...draft.colors, { r: 255, g: 255, b: 255 }] })}
            >
              Add colour
            </button>
            <button
              className="btn"
              disabled={draft.colors.length <= 1}
              onClick={() => patch({ colors: draft.colors.slice(0, -1) })}
            >
              Remove colour
            </button>
          </div>

          <div className="ctl">
            <label className="ctl__label" htmlFor="anim">Animation</label>
            <select
              id="anim"
              className="search"
              value={draft.anim}
              onChange={(e) => patch({ anim: e.target.value })}
            >
              {allowed.map((a) => <option key={a} value={a}>{ANIMS[a]}</option>)}
            </select>
            {allowed.length === 1 && (
              <p className="ctl__hint">Only layer events animate continuously; the rest flash once.</p>
            )}
          </div>

          {draft.anim === "blink" && (
            <>
              <NumRow label="On" value={draft.blinkOnMs} unit="ms" onChange={(v) => patch({ blinkOnMs: v })} />
              <NumRow label="Off" value={draft.blinkOffMs} unit="ms" onChange={(v) => patch({ blinkOffMs: v })} />
            </>
          )}
          {draft.anim === "breathe" && (
            <NumRow label="Breathe duration" value={draft.breatheDurMs} unit="ms" onChange={(v) => patch({ breatheDurMs: v })} />
          )}
          {draft.anim === "flash" && (
            <>
              <NumRow label="Flash duration" value={draft.flashDurMs} unit="ms" onChange={(v) => patch({ flashDurMs: v })} />
              <NumRow label="Fade-in" value={draft.flashEaseInMs} unit="ms" onChange={(v) => patch({ flashEaseInMs: v })} />
              <SelRow label="Fade-in curve" value={draft.flashEaseInFn} options={EASINGS} onChange={(v) => patch({ flashEaseInFn: v })} />
              <NumRow label="Fade-out" value={draft.flashEaseOutMs} unit="ms" onChange={(v) => patch({ flashEaseOutMs: v })} />
              <SelRow label="Fade-out curve" value={draft.flashEaseOutFn} options={EASINGS} onChange={(v) => patch({ flashEaseOutFn: v })} />
            </>
          )}

          <div className="ctl">
            <label className="ctl__label" htmlFor="fb">Vibration pattern</label>
            <input
              id="fb"
              className="search"
              value={draft.feedback.join(" ")}
              placeholder="e.g. 30 20 30"
              onChange={(e) => patch({
                feedback: e.target.value.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n)),
              })}
            />
            <p className="ctl__hint">Space-separated durations in ms. Leave empty for none.</p>
          </div>

          {note && <p className="warn warn--inline">{note}</p>}

          <div className="row row--wrap">
            <button className="btn btn--primary" onClick={save} disabled={busy}>Save event</button>
            <button className="btn" onClick={preview} disabled={busy}>Show on device</button>
            <button className="btn" onClick={load} disabled={busy}>Reload</button>
          </div>
        </>
      )}
    </>
  );
}

function NumRow({ label, value, unit, onChange }) {
  return (
    <div className="ctl ctl--inline">
      <label className="ctl__label">{label}</label>
      <span className="numwrap">
        <input
          type="number"
          min="0"
          value={value}
          aria-label={label}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        />
        <span className="unit">{unit}</span>
      </span>
    </div>
  );
}

function SelRow({ label, value, options, onChange }) {
  return (
    <div className="ctl ctl--inline">
      <label className="ctl__label">{label}</label>
      <select className="search search--slim" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
