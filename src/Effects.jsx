import { useCallback, useEffect, useRef, useState } from "react";
import { device } from "./device.js";
import {
  unsupported, EASINGS, parseEventList as parseList, parseEvent, validateEvent,
  parseLayers,
} from "./protocol.js";

// Per-event RGB and vibration. Events cover idle, USB connect/disconnect,
// each Bluetooth profile, battery warnings and every keymap layer.
//
// Only the event list is read up front. Fetching all ~20 events' details
// meant twenty round trips behind a 200 ms floor before the tab drew
// anything, so details load on selection and are cached after that.

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

/** Twenty-odd events in one dropdown is a scroll hunt; four short lists is not. */
export const CATEGORIES = [
  { id: "bt", label: "Bluetooth", match: (n) => n.startsWith("ble-profile") },
  { id: "layers", label: "Layers", match: (n) => n.startsWith("layer") },
  { id: "battery", label: "Battery", match: (n) => n.startsWith("batt-") },
  { id: "system", label: "System", match: () => true },
];

export const categoryOf = (name) => CATEGORIES.find((c) => c.match(name)).id;

const DEMO_NAMES = [
  ["idle", "Idle"],
  ["usb-conn", "USB connected"],
  ["usb-disconn", "USB disconnected"],
  ...[1, 2, 3, 4, 5].map((n) => [`ble-profile ${n}`, `Bluetooth device`]),
  ["no-endpoint", "No endpoint available"],
  ["studio-unlock", "Studio unlocked"],
  ...[1, 2, 3].map((n) => [`batt-warn ${n}`, "Battery warning"]),
  ...[1, 2, 3].map((n) => [`batt-crit ${n}`, "Battery critical"]),
  ...[0, 1, 2, 3, 4].map((n) => [`layer ${n}`, null]),
];

const PALETTE = ["#7cd4ff", "#63e6a0", "#ffa06a", "#ff6b8a", "#c58cff"];

const demoEvent = (name, i) => ({
  name,
  anim: name.startsWith("layer") ? "solid" : "flash",
  colors: [rgb(PALETTE[i % PALETTE.length])],
  blinkOnMs: 100, blinkOffMs: 100, breatheDurMs: 1000,
  flashDurMs: 200, flashEaseInMs: 40, flashEaseInFn: "quad-in",
  flashEaseOutMs: 60, flashEaseOutFn: "quad-out", feedback: [],
});

export default function Effects({ live, onNote }) {
  const [list, setList] = useState([]);        // [{ name, label }] — cheap
  const [cat, setCat] = useState("bt");
  const [sel, setSel] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loadingEvent, setLoadingEvent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [supportsRgb, setSupportsRgb] = useState(true);
  const [err, setErr] = useState(null);
  const cache = useRef(new Map());

  const loadList = useCallback(async () => {
    if (!live) {
      cache.current = new Map(DEMO_NAMES.map(([n], i) => [n, demoEvent(n, i)]));
      setList(DEMO_NAMES.map(([name, label]) => ({ name, label })));
      return;
    }
    setBusy(true);
    try {
      const listing = await device.send("argb list");
      if (unsupported(listing)) {
        onNote("Effects are not available on this firmware.");
        setList([]);
        return;
      }
      cache.current = new Map();
      // `argb list` gives layer events no label at all, so they read as
      // "layer 3". The board knows the real name; ask it, and fall back to the
      // bare number when the firmware has no `board layers`.
      const names = parseLayers(await device.send("board layers"));
      setList(parseList(listing).map((e) => {
        const n = e.label ? null : e.name.match(/^layer\s+(\d+)$/)?.[1];
        return n != null && names[n] ? { ...e, label: names[n] } : e;
      }));
      const support = await device.send("board rgb");
      setSupportsRgb(support.toLowerCase().includes("yes"));
    } catch (e) {
      onNote(e.message);
    } finally {
      setBusy(false);
    }
  }, [live, onNote]);

  useEffect(() => { loadList(); }, [loadList]);

  const inCat = list.filter((e) => categoryOf(e.name) === cat);

  // Keep the selection inside the visible category.
  useEffect(() => {
    if (!inCat.length) return;
    if (!inCat.some((e) => e.name === sel)) setSel(inCat[0].name);
  }, [cat, list]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the chosen event's detail once, then serve it from the cache.
  useEffect(() => {
    if (!sel) { setDraft(null); return; }
    let stale = false;
    const cached = cache.current.get(sel);
    if (cached) { setDraft(clone(cached)); setErr(null); return; }
    if (!live) return;

    setLoadingEvent(true);
    device.send(`argb evt ${sel} show`)
      .then((out) => {
        if (stale) return;
        const parsed = parseEvent(out, sel);
        cache.current.set(sel, parsed);
        setDraft(clone(parsed));
        setErr(null);
      })
      .catch((e) => !stale && onNote(e.message))
      .finally(() => !stale && setLoadingEvent(false));

    return () => { stale = true; };
  }, [sel, live, onNote]);

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    const bad = validateEvent(draft);
    if (bad) { setErr(bad); return; }
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
      cache.current.set(n, clone(draft));
      onNote(`Demo mode — ${cmds.length} commands would be sent.`);
      return;
    }
    setBusy(true);
    try {
      for (const c of cmds) await device.send(c);
      cache.current.set(n, clone(draft));
      onNote(`Saved “${labelFor(list, n)}”.`);
    } catch (e) {
      onNote(e.message);
    } finally {
      setBusy(false);
    }
  };

  const override = async () => {
    try {
      await device.send("board rgb override");
      setSupportsRgb(true);
      onNote("RGB override applied. Restart the board for it to take effect.");
    } catch (e) { onNote(e.message); }
  };

  if (!list.length) {
    return (
      <>
        <p className="panel__blurb">Colour and vibration for each device event.</p>
        <p className="empty">{busy ? "Reading effects…" : "No effects reported by this board."}</p>
        <button className="btn" onClick={loadList} disabled={busy}>Refresh</button>
      </>
    );
  }

  const allowed = draft ? animsFor(draft.name) : [];

  return (
    <>
      <p className="panel__blurb">
        Pick an event, then give it a colour. Each Bluetooth profile can light up differently.
      </p>

      {live && !supportsRgb && (
        <div className="notice">
          <p>This board does not report RGB support.</p>
          <button className="btn" onClick={override}>Force enable</button>
        </div>
      )}

      <div className="row row--wrap" role="tablist" aria-label="Event category">
        {CATEGORIES.map((c) => {
          const n = list.filter((e) => categoryOf(e.name) === c.id).length;
          if (!n) return null;
          return (
            <button
              key={c.id}
              role="tab"
              aria-selected={cat === c.id}
              className={"pill" + (cat === c.id ? " is-active" : "")}
              onClick={() => setCat(c.id)}
            >
              {c.label} <em>{n}</em>
            </button>
          );
        })}
      </div>

      <div className="ctl">
        <label className="ctl__label" htmlFor="evt">Event</label>
        <select id="evt" className="search" value={sel ?? ""} onChange={(e) => setSel(e.target.value)}>
          {inCat.map((e) => (
            <option key={e.name} value={e.name}>{display(e)}</option>
          ))}
        </select>
      </div>

      {loadingEvent && <p className="empty">Reading this event…</p>}

      {draft && !loadingEvent && (
        <>
          <div className="swatches">
            {draft.colors.map((c, i) => (
              <div key={i} className="swatch">
                <input
                  type="color"
                  aria-label={`Colour ${i + 1}`}
                  value={hex(c)}
                  onChange={(e) => patch({
                    colors: draft.colors.map((x, k) => (k === i ? rgb(e.target.value) : x)),
                  })}
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
            <select id="anim" className="search" value={draft.anim} onChange={(e) => patch({ anim: e.target.value })}>
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

          {err && <p className="warn warn--inline">{err}</p>}

          <div className="actions">
            <button className="btn btn--primary" onClick={save} disabled={busy}>Save event</button>
            <button className="btn" onClick={loadList} disabled={busy}>Reload all</button>
          </div>
        </>
      )}
    </>
  );
}

const clone = (e) => ({ ...e, colors: e.colors.map((c) => ({ ...c })) });

const display = (e) => (e.label ? `${e.label} — ${e.name}` : e.name);

const labelFor = (list, name) => {
  const e = list.find((x) => x.name === name);
  return e?.label ?? name;
};

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
