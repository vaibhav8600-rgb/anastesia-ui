import { useCallback, useEffect, useRef, useState } from "react";
import {
  Request, Response, decode, encode, frame, subsystemOf, unframer,
  LOCKED, UNLOCKED, META_ERRORS,
} from "./studio.js";
import { ALL_CHOICES, CHOICE_GROUPS, MOUSE_CHOICES, usageName, usageShort } from "./keycodes.js";
import Loading from "./Loading.jsx";

// The keymap editor: layers, key positions and bindings, read and written over
// ZMK Studio's RPC.
//
// It gets its own serial port and its own connection, because it is a separate
// protocol on a separate USB interface — this board's build uses the
// studio-rpc-usb-uart snippet, so the RPC rides a second CDC-ACM endpoint. The
// port you pick here is not the one the settings tabs use, and a port can only
// be held by one page at a time.

const BAUD = 115200;          // CDC-ACM ignores it, but open() demands one
// Long enough for a board that is awake, short enough that probing the wrong
// port costs a moment rather than the full request timeout.
const PROBE_MS = 2500;

/**
 * Find the port that speaks RPC by asking each one.
 *
 * The board exposes two CDC-ACM interfaces from the same USB device — one for
 * the Zephyr shell, one for Studio's RPC — so they share a vendor and product
 * id and requestPort() filters cannot separate them. On this hardware they
 * come up as two COM ports with the same name, and which is which is not
 * something a person should have to know. So: try each port the user has
 * already granted, ask it who it is, and keep the one that answers.
 *
 * A port the settings tabs are holding fails to open and is skipped, which is
 * exactly the behaviour wanted — that is the shell port by definition.
 */
async function findRpcPort(onTry) {
  for (const port of await navigator.serial.getPorts()) {
    // Already open with a reader on it means something else in this page has
    // it — the settings connection. That is the shell port by definition, and
    // trying to read it throws rather than failing politely.
    if (port.readable?.locked || port.writable?.locked) continue;
    const link = new Link();
    try {
      onTry?.();
      await link.connect(port);
      const info = await link.call("core", { get_device_info: true }, PROBE_MS);
      return { link, info: info.get_device_info ?? null };
    } catch {
      await link.close();
    }
  }
  return null;
}

/** One request in flight at a time, matched back by request_id. */
class Link {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = null;
    this.onClose = null;
  }

  get open() { return !!this.port; }

  /** Take an already-open port, or ask for one. */
  async connect(port) {
    const p = port ?? await navigator.serial.requestPort();
    if (!p.readable) await p.open({ baudRate: BAUD });
    this.port = p;
    this.writer = p.writable.getWriter();
    this.read();
    return this;
  }

  async read() {
    const push = unframer();
    try {
      this.reader = this.port.readable.getReader();
    } catch {
      // Someone else holds this stream. Nothing to read, and throwing from an
      // un-awaited call would surface as an unhandled rejection.
      this.onClose?.();
      return;
    }
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const payload of push(value)) this.dispatch(payload);
      }
    } catch { /* cancelled on disconnect */ } finally {
      this.onClose?.();
    }
  }

  dispatch(payload) {
    let msg;
    try { msg = decode(Response, payload); } catch { return; }
    if (msg.notification) { this.onNotification?.(msg.notification); return; }
    const rr = msg.request_response;
    if (!rr) return;
    const waiting = this.pending.get(rr.request_id);
    if (!waiting) return;
    this.pending.delete(rr.request_id);
    waiting(rr);
  }

  /** Send one subsystem request and wait for its reply. */
  call(subsystem, body, ms = 8000) {
    const request_id = this.nextId++;
    const bytes = frame(encode(Request, { request_id, [subsystem]: body }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error("The board did not answer. Is this the RPC port rather than the shell one?"));
      }, ms);
      this.pending.set(request_id, (rr) => {
        clearTimeout(timer);
        const where = subsystemOf(rr);
        if (where === "meta") {
          const code = rr.meta.simple_error ?? 0;
          reject(new Error(META_ERRORS[code] ?? `Board error ${code}.`));
          return;
        }
        resolve(rr[where] ?? {});
      });
      this.writer.write(bytes).catch(reject);
    });
  }

  async close() {
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    try { await this.port?.close(); } catch { /* already closed */ }
    this.port = this.reader = this.writer = null;
    this.pending.clear();
  }
}

/**
 * Which namespace a behavior's first parameter lives in. Mouse buttons are
 * bitmasks, HID usages are page-encoded, and the number alone cannot tell you
 * which — a bare 4 is both the letter A and the middle button.
 */
export function paramKind(name) {
  if (/mouse|mkp|mb|click/i.test(name ?? "")) return "mouse";
  if (/press|kp|consumer|key/i.test(name ?? "")) return "usage";
  return null;
}

/** Bindings come back as ids and numbers; make them a sentence. */
function describe(binding, behaviors) {
  if (!binding || Object.keys(binding).length === 0) return { name: "—", full: "Unbound", detail: null };
  const id = binding.behavior_id ?? 0;
  const b = behaviors.get(id);
  const name = b?.display_name ?? `#${id}`;
  const p1 = binding.param1 ?? 0;
  const p2 = binding.param2 ?? 0;
  // A key press is by far the most common binding, and showing "Key Press
  // 458756" for it would defeat the point of drawing a keymap at all.
  // Anything carrying a HID usage reads as the key it sends. That is key
  // press, mouse button press and consumer keys alike — they differ only in
  // which page the usage is on, which usageName already knows.
  const kind = paramKind(name);
  const meta = b?.metadata?.[0] ?? {};
  // The board names its own parameters, so a two-parameter binding can say
  // which is which instead of printing "1, 29" and leaving you to guess.
  const named = (descs, value, fallback) => {
    if (!descs?.length) return null;
    const label = descs.find((d) => d.name)?.name ?? fallback;
    return `${label}: ${usageName(value, kind) ?? value}`;
  };
  const parts = [named(meta.param1, p1, "first"), named(meta.param2, p2, "second")]
    .filter(Boolean);

  // A single-parameter key that sends something reads as the thing it sends.
  if (p1 && kind && !meta.param2?.length) {
    return { name: usageShort(p1, kind), full: usageName(p1, kind), detail: name };
  }
  if (parts.length) return { name, full: `${name} — ${parts.join(", ")}`, detail: null };
  if (p1 || p2) return { name, full: name, detail: p2 ? `${p1}, ${p2}` : String(p1) };
  return { name, full: name, detail: null };
}

export default function Studio({ onNote }) {
  const link = useRef(null);
  const [state, setState] = useState("idle");   // idle | opening | ready
  const [device, setDevice] = useState(null);
  const [locked, setLocked] = useState(null);
  const [keymap, setKeymap] = useState(null);
  const [layouts, setLayouts] = useState(null);
  const [behaviors, setBehaviors] = useState(new Map());
  const [layer, setLayer] = useState(0);
  const [picking, setPicking] = useState(null);   // key position being edited
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const l = link.current;
    const lock = await l.call("core", { get_lock_state: true });
    setLocked(lock.get_lock_state === LOCKED);

    const km = await l.call("keymap", { get_keymap: true });
    setKeymap(km.get_keymap ?? null);
    const pl = await l.call("keymap", { get_physical_layouts: true });
    setLayouts(pl.get_physical_layouts ?? null);
    const unsaved = await l.call("keymap", { check_unsaved_changes: true });
    setDirty(!!unsaved.check_unsaved_changes);

    // Behaviour names are a second round trip each, so they are fetched once
    // and cached. Without them every key would read as "#-3".
    const all = await l.call("behaviors", { list_all_behaviors: true });
    const ids = all.list_all_behaviors?.behaviors ?? [];
    const map = new Map();
    for (const id of ids) {
      try {
        const d = await l.call("behaviors", { get_behavior_details: { behavior_id: id } });
        const details = d.get_behavior_details;
        if (details) map.set(details.id ?? id, details);
      } catch { /* one missing name is not worth failing the whole load */ }
    }
    setBehaviors(map);
  }, []);

  const wire = (l) => {
    l.onNotification = (n) => {
      if (n.keymap?.unsaved_changes_status_changed !== undefined) {
        setDirty(!!n.keymap.unsaved_changes_status_changed);
      }
      if (n.core?.lock_state_changed !== undefined) {
        setLocked(n.core.lock_state_changed === LOCKED);
      }
    };
    l.onClose = () => { setState("idle"); };
    return l;
  };

  const connect = async (pick = false) => {
    if (!("serial" in navigator)) { onNote?.("This browser has no Web Serial."); return; }
    setState("opening");
    try {
      // Try what is already granted first. Only ask for a port when nothing
      // granted answers, so the second visit never shows a chooser at all.
      let found = pick ? null : await findRpcPort();
      if (!found) {
        const l = new Link();
        await l.connect();
        const info = await l.call("core", { get_device_info: true }, PROBE_MS)
          .catch(async (e) => { await l.close(); throw e; });
        found = { link: l, info: info.get_device_info ?? null };
      }
      link.current = wire(found.link);
      setDevice(found.info);
      await load();
      setState("ready");
      onNote?.(null);
    } catch (err) {
      await link.current?.close();
      link.current = null;
      setState("idle");
      onNote?.(
        err?.name === "NotFoundError" ? "No port picked."
          : /did not answer/.test(String(err?.message))
            ? "That port did not answer. This board shows two — one is the shell the settings tabs use, the other is the RPC. Try the other one."
            : String(err?.message ?? err),
      );
    }
  };

  const disconnect = async () => { await link.current?.close(); setState("idle"); };

  useEffect(() => () => { link.current?.close(); }, []);

  const setBinding = async (position, binding) => {
    setBusy(true);
    try {
      const l = keymap.layers[layer];
      const res = await link.current.call("keymap", {
        // proto3 leaves a zero out, so layer 0 arrives without an id.
        set_layer_binding: { layer_id: l.id ?? 0, key_position: position, binding },
      });
      const code = res.set_layer_binding ?? 0;
      if (code !== 0) {
        const why = { 1: "that key position", 2: "that behavior", 3: "those parameters" }[code];
        onNote?.(`The board rejected ${why ?? "the change"}.`);
        return;
      }
      // Reflect it locally rather than re-reading the whole keymap for one key.
      setKeymap((km) => {
        const next = structuredClone(km);
        next.layers[layer].bindings[position] = binding;
        return next;
      });
      setPicking(null);
      // Ask rather than assume: the board is the authority on whether anything
      // is pending, and one missed notification should not strand a change.
      try {
        const unsaved = await link.current.call("keymap", { check_unsaved_changes: true });
        setDirty(!!unsaved.check_unsaved_changes);
      } catch { setDirty(true); }
      onNote?.("Key set. It is live on the board now; Save writes it to storage.");
    } catch (err) {
      onNote?.(String(err?.message ?? err));
    } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await link.current.call("keymap", { save_changes: true });
      const err = res.save_changes?.err;
      if (err) {
        onNote?.({ 2: "This firmware cannot save keymap changes.", 3: "No space left on the board." }[err]
          ?? "The board could not save the changes.");
        return;
      }
      setDirty(false);
      onNote?.("Keymap saved to the board.");
    } catch (e) { onNote?.(String(e?.message ?? e)); } finally { setBusy(false); }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await link.current.call("keymap", { discard_changes: true });
      await load();
      setDirty(false);
      onNote?.("Changes discarded; the board's saved keymap is back.");
    } catch (e) { onNote?.(String(e?.message ?? e)); } finally { setBusy(false); }
  };

  if (state !== "ready") {
    return (
      <>
        <h3 className="sec">Key bindings</h3>
        <p className="ctl__hint">
          Bindings are not in this firmware's shell — they live behind ZMK
          Studio's RPC, which this app speaks directly. The board exposes that
          on a second USB serial interface, so the editor needs its own
          connection. It works out which of the board's ports that is by asking
          each one, so you should not have to know.
        </p>
        <div className="row row--wrap">
          <button className="btn btn--primary" onClick={() => connect(false)} disabled={state === "opening"}>
            {state === "opening" ? "Looking for the board…" : "Connect the keymap editor"}
          </button>
          <button className="btn btn--ghost" onClick={() => connect(true)} disabled={state === "opening"}>
            Pick the port myself
          </button>
        </div>
        {state === "opening" && <Loading label="Reading the keymap…" />}
      </>
    );
  }

  const layout = layouts?.layouts?.[layouts.active_layout_index ?? 0];
  const current = keymap?.layers?.[layer];
  const keys = layout?.keys ?? [];
  // Physical layouts are in hundredths of a key unit. Normalise to the widest
  // row so the board fills whatever width the panel gives it.
  const extentX = Math.max(...keys.map((k) => (k.x ?? 0) + (k.width ?? 100)), 100);
  const extentY = Math.max(...keys.map((k) => (k.y ?? 0) + (k.height ?? 100)), 100);

  return (
    <>
      <h3 className="sec">Key bindings</h3>
      <div className="row row--wrap">
        <span className="chip chip--live">{device?.name || "connected"}</span>
        {locked && <span className="chip">locked</span>}
        {dirty && <span className="chip">unsaved</span>}
        <span className="actions__gap" />
        <button className="btn btn--ghost" onClick={disconnect}>Disconnect editor</button>
      </div>

      {locked && (
        <p className="warn warn--inline">
          The board is locked, so it will refuse changes. Press the
          studio-unlock key on the board — the lock clears here on its own.
        </p>
      )}

      <div className="row row--wrap">
        {(keymap?.layers ?? []).map((l, i) => (
          <button
            key={l.id ?? i}
            className={"pill" + (i === layer ? " is-active" : "")}
            onClick={() => { setLayer(i); setPicking(null); }}
          >
            {l.name || `Layer ${i}`}
          </button>
        ))}
      </div>

      {layout ? (
        <div className="kmap" style={{ aspectRatio: `${extentX} / ${extentY}` }}>
          {keys.map((k, position) => {
            const b = describe(current?.bindings?.[position], behaviors);
            return (
              <button
                key={position}
                className={"kmap__key" + (picking === position ? " is-active" : "")}
                style={{
                  left: `${((k.x ?? 0) / extentX) * 100}%`,
                  top: `${((k.y ?? 0) / extentY) * 100}%`,
                  width: `${((k.width ?? 100) / extentX) * 100}%`,
                  height: `${((k.height ?? 100) / extentY) * 100}%`,
                  transform: k.r ? `rotate(${k.r / 100}deg)` : undefined,
                }}
                title={b.detail ? `${b.full} · ${b.detail}` : b.full}
                onClick={() => setPicking(picking === position ? null : position)}
              >
                {b.name}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="ctl__hint">
          This board reports no physical layout, so its keys cannot be drawn in
          position. The bindings are still listed below.
        </p>
      )}

      {!layout && (
        <ol className="kmap__list">
          {(current?.bindings ?? []).map((binding, position) => {
            const b = describe(binding, behaviors);
            return (
              <li key={position}>
                <button className="pill" onClick={() => setPicking(position)}>
                  {position}: {b.name}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {picking !== null && (
        <Picker
          key={picking}
          position={picking}
          behaviors={behaviors}
          binding={current?.bindings?.[picking]}
          busy={busy}
          onCancel={() => setPicking(null)}
          onPick={(binding) => setBinding(picking, binding)}
        />
      )}

      <div className="actions">
        {/* Not gated on `dirty`. That flag is this app's belief about the
            board, and a board that has unsaved changes we did not make — or a
            notification we missed — would leave the only way to commit them
            greyed out. The board is the one that knows; let it decide. */}
        <button className="btn btn--primary" onClick={save} disabled={busy}>
          {dirty ? "Save to board" : "Save to board"}
        </button>
        <button className="btn" onClick={discard} disabled={busy}>Discard</button>
        <span className="actions__gap" />
        <button className="btn btn--ghost" onClick={load} disabled={busy}>Re-read</button>
      </div>
    </>
  );
}

/** Choose what one key does: a behavior, and whatever parameters it takes. */
/**
 * One parameter, rendered as whatever the board says it accepts.
 *
 * The metadata is a list of descriptions, each naming a kind: a layer index, a
 * HID usage, a numeric range, or a fixed constant. A behavior that takes a
 * layer and a keycode says exactly that, so the control and its label both
 * come from the board rather than from a guess about the behavior's name.
 */
function ParamField({ id, label, descs, kind, value, onChange }) {
  if (!descs?.length) return null;

  // Named constants are a closed set of choices — the clearest case there is.
  const constants = descs.filter((d) => d.constant !== undefined);
  if (constants.length === descs.length && constants.length > 0) {
    return (
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={id}>{label}</label>
        <select id={id} className="search search--slim" value={value}
                onChange={(e) => onChange(Number(e.target.value))}>
          {constants.map((c) => (
            <option key={c.constant} value={c.constant}>{c.name || c.constant}</option>
          ))}
        </select>
      </div>
    );
  }

  const wantsLayer = descs.some((d) => d.layer_id);
  const range = descs.find((d) => d.range)?.range;

  if (wantsLayer) {
    return (
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={id}>{label}</label>
        <input id={id} type="number" className="search search--slim" min={0}
               value={value} onChange={(e) => onChange(Number(e.target.value))} />
      </div>
    );
  }

  const choices = kind === "mouse" ? MOUSE_CHOICES : null;
  const known = (choices ?? ALL_CHOICES).some((c) => c.param === value);
  return (
    <>
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={id}>{label}</label>
        <select id={id} className="search search--slim" value={known ? value : ""}
                onChange={(e) => onChange(Number(e.target.value))}>
          <option value="">{known ? "—" : `custom (${value})`}</option>
          {choices
            ? choices.map((c) => <option key={c.param} value={c.param}>{c.name}</option>)
            : CHOICE_GROUPS.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((c) => <option key={c.param} value={c.param}>{c.name}</option>)}
              </optgroup>
            ))}
        </select>
      </div>
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={`${id}-raw`}>{label} — raw value</label>
        <input id={`${id}-raw`} type="number" className="search search--slim"
               min={range?.min} max={range?.max} value={value}
               onChange={(e) => onChange(Number(e.target.value))} />
      </div>
    </>
  );
}

/** Choose what one key does: a behavior, and whatever parameters it takes. */
function Picker({ position, behaviors, binding, busy, onCancel, onPick }) {
  // Sorted by name, because the board's own order is its internal table and
  // hunting for "Key Press" in twenty unsorted entries is what made binding a
  // volume key feel impossible.
  const list = [...behaviors.values()]
    .sort((a, b) => (a.display_name || "").localeCompare(b.display_name || ""));
  const [filter, setFilter] = useState("");
  const [id, setId] = useState(binding?.behavior_id ?? list[0]?.id ?? 0);
  const [param1, setParam1] = useState(binding?.param1 ?? 0);
  const [param2, setParam2] = useState(binding?.param2 ?? 0);

  const shown = filter
    ? list.filter((b) => (b.display_name || "").toLowerCase().includes(filter.toLowerCase()))
    : list;

  const chosen = behaviors.get(id);
  const kind = paramKind(chosen?.display_name);
  const set = chosen?.metadata?.[0] ?? {};
  const p1 = set.param1 ?? [];
  const p2 = set.param2 ?? [];

  // The board names its parameters — "layer", "keycode" — and for a hold-tap
  // that naming is the whole answer to "what happens when I hold it".
  const nameOf = (descs, fallback) => {
    const named = descs.find((d) => d.name)?.name;
    return named ? named[0].toUpperCase() + named.slice(1) : fallback;
  };
  const holdTap = /hold\s*[/-]?\s*tap/i.test(chosen?.display_name ?? "");
  const label1 = nameOf(p1, holdTap ? "When held" : "Sends");
  const label2 = nameOf(p2, holdTap ? "When tapped" : "Second value");

  const preview = [
    p1.length ? `${label1}: ${usageName(param1, kind) ?? param1}` : null,
    p2.length ? `${label2}: ${usageName(param2, kind) ?? param2}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="surface picker">
      <h4 className="advgroup__title">Key {position}</h4>

      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor="pick-filter">Find a behavior</label>
        <input
          id="pick-filter" type="search" className="search search--slim"
          placeholder={`${list.length} available`}
          value={filter} onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor="pick-behavior">Behavior</label>
        <select
          id="pick-behavior"
          className="search search--slim"
          value={id}
          onChange={(e) => { setId(Number(e.target.value)); setParam1(0); setParam2(0); }}
        >
          {shown.map((b) => (
            <option key={b.id} value={b.id}>{b.display_name || `#${b.id}`}</option>
          ))}
        </select>
      </div>

      <ParamField id="pick-p1" label={label1} descs={p1} kind={kind}
                  value={param1} onChange={setParam1} />
      <ParamField id="pick-p2" label={label2} descs={p2} kind={kind}
                  value={param2} onChange={setParam2} />

      {p1.length === 0 && p2.length === 0 && (
        <p className="ctl__hint">This behavior takes no parameters — it does one thing.</p>
      )}
      {preview && <p className="ctl__hint">{preview}</p>}

      <div className="row row--wrap">
        <button
          className="btn btn--primary"
          disabled={busy}
          onClick={() => onPick({ behavior_id: id, param1, param2 })}
        >
          {busy ? "Writing…" : "Set key"}
        </button>
        <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
