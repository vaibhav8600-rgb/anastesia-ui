import { useCallback, useEffect, useRef, useState } from "react";
import {
  Request, Response, decode, encode, frame, subsystemOf, unframer,
  LOCKED, UNLOCKED, META_ERRORS,
} from "./studio.js";
import { ALL_CHOICES, CHOICE_GROUPS, MOUSE_BUTTONS, usageName, usageShort } from "./keycodes.js";
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
          const err = new Error(META_ERRORS[code] ?? `Board error ${code}.`);
          err.code = code;
          reject(err);
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
/** UNLOCK_REQUIRED from zmk/meta.proto. */
const ERR_LOCKED = 1;

export function paramKind(name) {
  if (/mouse|mkp|mb|click/i.test(name ?? "")) return "mouse";
  if (/press|kp|consumer|key/i.test(name ?? "")) return "usage";
  return null;
}

/** Bindings come back as ids and numbers; make them a sentence. */
function describe(binding, behaviors, layers) {
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
  const i1 = paramInfo(meta.param1);
  const i2 = paramInfo(meta.param2);

  // A key that only sends one thing reads as that thing. Mouse buttons are the
  // exception worth making: the board calls them MB1, and "Left Click" is what
  // the key actually does.
  if (p1 && kind && i2.kind === "none") {
    return { name: usageShort(p1, kind), full: usageName(p1, kind), detail: name };
  }

  // Two parameters: the cap shows the values, not the behavior's name. Knowing
  // a key is a hold/tap without knowing which layer or which key it holds and
  // taps is the least useful thing the cap could say.
  const holdTap = /hold\s*[\/-]?\s*tap/i.test(name);
  const part = (info, value, fallback) => (info.kind === "none" ? null
    : `${fallback}: ${paramValueName(info, value, layers)}`);
  const parts = [
    part(i1, p1, holdTap ? "hold" : "first"),
    part(i2, p2, holdTap ? "tap" : "then"),
  ].filter(Boolean);

  if (i1.kind !== "none" && i2.kind !== "none") {
    // Tap is what an ordinary press does, so it gets the cap; hold sits under
    // it in smaller type, prefixed so the two are never mistaken for each other.
    return {
      name: paramShort(i2, p2, layers),
      sub: `hold ${paramShort(i1, p1, layers)}`,
      full: `${name} — ${parts.join(", ")}`,
      detail: null,
    };
  }
  if (parts.length) return { name, full: `${name} — ${parts.join(", ")}`, detail: null };
  return { name, full: name, detail: null };
}

/**
 * The board's keys in the order the model rings them: by angle around the
 * layout's centre, largest keys only.
 *
 * The model has eight keys and no encoders, so the slivers are dropped rather
 * than shifting everything after them by one. Sorting both sides by the same
 * geometric rule is what pairs them — neither has to know the other's indices,
 * and the ordering is derived from the board's own coordinates rather than
 * from an assumption that two build orders happen to agree.
 */
export function ringOrder(keys, count = 8) {
  if (!keys?.length) return [];
  // Largest first, and only then a centre. Taking the centre of every key
  // would let the encoders — which the model has no keys for — drag it off to
  // one side, and a moved centre rotates the whole ring: the sequence stays
  // right but starts on the wrong key, so every label lands one place over.
  const chosen = keys
    .map((k, position) => ({ position, k, area: (k.width ?? 100) * (k.height ?? 100) }))
    .sort((a, b) => b.area - a.area)
    .slice(0, count);

  const cx = chosen.reduce((a, { k }) => a + (k.x ?? 0) + (k.width ?? 100) / 2, 0) / chosen.length;
  const cy = chosen.reduce((a, { k }) => a + (k.y ?? 0) + (k.height ?? 100) / 2, 0) / chosen.length;

  return chosen
    .map((c) => ({
      ...c,
      // Not negated. Two negations cancelled and mirrored the board: the
      // model's shape axis already runs opposite to the layout's screen y, and
      // the flat rotation negates it a second time on the way to world z. The
      // result was a vertical flip — the top-left key labelled bottom-left,
      // the bottom-middle key labelled top-left — which is what a mirror looks
      // like as against a rotation, and is how it was spotted.
      //
      // Normalised to [0, 2pi) because atan2 returns -pi for a key due west
      // when the vertical difference is negative zero and +pi when it is
      // positive zero. Left alone, a key on that boundary would jump from one
      // end of the ring to the other on the sign of a zero.
      angle: (Math.atan2((c.k.y ?? 0) + (c.k.height ?? 100) / 2 - cy,
        (c.k.x ?? 0) + (c.k.width ?? 100) / 2 - cx) + Math.PI * 2) % (Math.PI * 2),
    }))
    .sort((a, b) => a.angle - b.angle)
    .map((c) => c.position);
}

/**
 * The keys the ring left behind, gathered per encoder.
 *
 * A wheel turns two ways, so its two directions are two key positions in the
 * layout. Splitting the leftovers by which side of the board they sit on pairs
 * them with the wheel that is physically there, and joining each pair gives a
 * wheel one label rather than two labels fighting for the same spot.
 */
export function wheelOrder(keys, count = 8) {
  if (!keys?.length) return [];
  const kept = new Set(ringOrder(keys, count));
  const rest = keys
    .map((k, position) => ({ position, mid: (k.x ?? 0) + (k.width ?? 100) / 2 }))
    .filter((k) => !kept.has(k.position))
    .sort((a, b) => a.mid - b.mid);
  if (!rest.length) return [];
  const half = Math.ceil(rest.length / 2);
  return [rest.slice(0, half).map((k) => k.position),
    rest.slice(half).map((k) => k.position)];
}

export default function Studio({ onNote, onKeyLabels, onWheelLabels }) {
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
  // The lock is not a note in a corner. Until it is cleared nothing you press
  // has any effect, so it gets stated in the middle and waits to be read.
  const [lockSeen, setLockSeen] = useState(false);

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
        // Unlocking clears the dialog, and locking again brings it back rather
        // than staying dismissed from the last time.
        setLockSeen(false);
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
      // A locked board is not a connection failure and does not belong in a
      // corner. Keep the link, raise the dialog, and say so in the middle.
      if (err?.code === ERR_LOCKED) {
        setLocked(true);
        setLockSeen(false);
        setState("idle");
        return;
      }
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

  // Open the editor when the tab is opened. The ports are already granted, so
  // this is a probe rather than a prompt — no chooser appears, and if nothing
  // answers it simply stays on the connect button without an error, because
  // "you have not plugged anything in" is not a failure worth announcing.
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    let cancelled = false;
    (async () => {
      if (!("serial" in navigator)) return;
      try {
        const found = await findRpcPort();
        if (!found || cancelled) { await found?.link.close(); return; }
        link.current = wire(found.link);
        setDevice(found.info);
        setState("opening");
        await load();
        setState("ready");
      } catch (err) {
        if (err?.code === ERR_LOCKED) { setLocked(true); setLockSeen(false); }
        await link.current?.close();
        link.current = null;
        setState("idle");
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  // Hand the model the same bindings, ordered its way. Cleared on unmount so
  // the labels do not outlive the tab that meant them.
  const labelKeys = layouts?.layouts?.[layouts.active_layout_index ?? 0]?.keys;
  const shownLayer = keymap?.layers?.[layer];
  useEffect(() => {
    if (!onKeyLabels) return undefined;
    if (!labelKeys?.length || !shownLayer) { onKeyLabels([]); return undefined; }
    onKeyLabels(ringOrder(labelKeys).map((position) => {
      const d = describe(shownLayer.bindings?.[position], behaviors, keymap?.layers);
      return d.sub ? `${d.name} · ${d.sub}` : d.name;
    }));
    return () => onKeyLabels([]);
  }, [onKeyLabels, labelKeys, shownLayer, behaviors, keymap]);

  // And the encoders, which the ring drops because the model has no keys for
  // them — it has wheels.
  useEffect(() => {
    if (!onWheelLabels) return undefined;
    if (!labelKeys?.length || !shownLayer) { onWheelLabels([]); return undefined; }
    onWheelLabels(wheelOrder(labelKeys).map((group) => group
      .map((position) => describe(shownLayer.bindings?.[position], behaviors, keymap?.layers).name)
      .filter((n) => n && n !== "—")
      .join(" / ")));
    return () => onWheelLabels([]);
  }, [onWheelLabels, labelKeys, shownLayer, behaviors, keymap]);

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
      if (err?.code === ERR_LOCKED) { setLocked(true); setLockSeen(false); }
      else onNote?.(String(err?.message ?? err));
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
    } catch (e) {
      if (e?.code === ERR_LOCKED) { setLocked(true); setLockSeen(false); }
      else onNote?.(String(e?.message ?? e));
    } finally { setBusy(false); }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await link.current.call("keymap", { discard_changes: true });
      await load();
      setDirty(false);
      onNote?.("Changes discarded; the board's saved keymap is back.");
    } catch (e) {
      if (e?.code === ERR_LOCKED) { setLocked(true); setLockSeen(false); }
      else onNote?.(String(e?.message ?? e));
    } finally { setBusy(false); }
  };

  const lockDialog = locked && !lockSeen && (
    <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="modal__card modal__card--warn">
        <div className="modal__head">
          {/* The triangle carries the meaning before the words do, which is
              the point of it — and it is the shape people already read as
              "stop and look" without having to. */}
          <svg className="modal__icon" viewBox="0 0 24 24" role="img"
               aria-label="Warning" focusable="false">
            <path d="M12 2.6 22.4 20.4a1.2 1.2 0 0 1-1.04 1.8H2.64a1.2 1.2 0 0 1-1.04-1.8Z" />
            <rect className="modal__bang" x="11" y="8.4" width="2" height="6.4" rx="1" />
            <circle className="modal__bang" cx="12" cy="17.8" r="1.25" />
          </svg>
          <h3 className="modal__title" id="lock-title">The board is locked</h3>
        </div>
        <p className="modal__body">
          ZMK Studio locks the keymap until you say otherwise, so the board
          refuses to hand it over or change it while this is on. Press the
          <strong> studio-unlock </strong> key on the device — this clears
          itself the moment it does, without you coming back here.
        </p>
        <div className="row row--wrap">
          <button className="btn btn--primary" onClick={() => { setLockSeen(true); connect(false); }}>
            I have unlocked it
          </button>
          <button className="btn btn--ghost" onClick={() => setLockSeen(true)}>Dismiss</button>
        </div>
      </div>
    </div>
  );

  if (state !== "ready") {
    return (
      <>
        {lockDialog}
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
  // Physical layouts are in hundredths of a key unit, and nothing says they
  // start at the origin — a board can place keys at negative coordinates, and
  // measuring only the far edge then pushes those off the box entirely. Take
  // both ends, and leave a margin so an edge key is not flush against the
  // frame with its label touching the border.
  const PAD = 8;
  const bounds = keys.reduce((a, k) => ({
    minX: Math.min(a.minX, k.x ?? 0),
    minY: Math.min(a.minY, k.y ?? 0),
    maxX: Math.max(a.maxX, (k.x ?? 0) + (k.width ?? 100)),
    maxY: Math.max(a.maxY, (k.y ?? 0) + (k.height ?? 100)),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const spanX = Math.max(1, (bounds.maxX - bounds.minX) + PAD * 2);
  const spanY = Math.max(1, (bounds.maxY - bounds.minY) + PAD * 2);

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

      {lockDialog}

      {locked && lockSeen && (
        <p className="warn warn--inline">
          Still locked — press the studio-unlock key on the board.
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
        <div className="kmap" style={{ aspectRatio: `${spanX} / ${spanY}` }}>
          {keys.map((k, position) => {
            const b = describe(current?.bindings?.[position], behaviors, keymap?.layers);
            const w = k.width ?? 100;
            const h = k.height ?? 100;
            // Type scaled to the key it sits in, in container units so it
            // follows the board's own width. A narrow encoder key gets small
            // type rather than a clipped label.
            const size = ((w / spanX) * 100 * 0.13).toFixed(2);
            // An encoder key is a sliver of the board. No type size fits
            // "Volume Down" inside it, so it carries a dot and its binding is
            // listed under the board instead of being shrunk into illegibility.
            const tiny = (w / spanX) < 0.055 || (h / spanY) < 0.055;
            return (
              <button
                key={position}
                className={"kmap__key"
                  + (picking === position ? " is-active" : "")
                  + (tiny ? " kmap__key--tiny" : "")
}
                style={{
                  left: `${((k.x ?? 0) - bounds.minX + PAD) / spanX * 100}%`,
                  top: `${((k.y ?? 0) - bounds.minY + PAD) / spanY * 100}%`,
                  width: `${(w / spanX) * 100}%`,
                  height: `${(h / spanY) * 100}%`,
                  fontSize: `clamp(7px, ${size}cqw, 13px)`,
                  transform: k.r ? `rotate(${k.r / 100}deg)` : undefined,
                }}
                title={b.detail ? `${b.full} · ${b.detail}` : b.full}
                onClick={() => setPicking(picking === position ? null : position)}
              >
                {tiny ? <span className="kmap__dot" aria-hidden="true" /> : (
                  <>
                    <span className="kmap__cap">{b.name}</span>
                    {b.sub && <span className="kmap__sub">{b.sub}</span>}
                  </>
                )}
                {tiny && <span className="sr-only">{b.full}</span>}
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

      {layout && (() => {
        // Grouped by encoder, not by layout order. Listing them in raw position
        // order put Volume Up, then the other wheel, then Volume Down — the two
        // halves of one encoder split by an unrelated key.
        const small = wheelOrder(keys).flat().map((position) => ({ position }));
        if (!small.length) return null;
        return (
          <>
            <p className="ctl__hint">
              Marked with a dot on the board — too small to label in place:
            </p>
            <div className="row row--wrap">
              {small.map(({ position }) => {
                const b = describe(current?.bindings?.[position], behaviors, keymap?.layers);
                return (
                  <button
                    key={position}
                    className={"pill" + (picking === position ? " is-active" : "")}
                    onClick={() => setPicking(picking === position ? null : position)}
                  >
                    {b.name}{b.sub ? ` · ${b.sub}` : ""}
                  </button>
                );
              })}
            </div>
          </>
        );
      })()}

      {!layout && (
        <ol className="kmap__list">
          {(current?.bindings ?? []).map((binding, position) => {
            const b = describe(binding, behaviors, keymap?.layers);
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
          layers={keymap?.layers}
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

/**
 * What one parameter actually is, read from its own descriptors.
 *
 * This has to be per parameter, not per behavior. "Hold/tap (layer/mouse key)"
 * takes a layer first and a button second, and deciding from the behavior's
 * name made the app read the layer as a mouse button and print
 * "Layer: Right Click".
 */
export function paramInfo(descs) {
  if (!descs?.length) return { kind: "none" };
  const constants = descs.filter((d) => d.constant !== undefined);
  // A closed set of named values. Their names are the choices — MB1, MB2 —
  // and emphatically not the name of the parameter itself.
  if (constants.length === descs.length) return { kind: "constant", options: constants };
  if (descs.some((d) => d.layer_id)) return { kind: "layer" };
  if (descs.some((d) => d.hid_usage)) return { kind: "usage" };
  const range = descs.find((d) => d.range)?.range;
  if (range) return { kind: "range", range };
  return { kind: "usage" };
}

const TYPE_WORD = {
  layer: "a layer", usage: "any key", constant: "one of a fixed set",
  range: "a number", none: "nothing",
};

/**
 * Every two-parameter behavior the board has, with what each half accepts.
 *
 * A behavior's parameter types are fixed in the firmware — "Hold/tap
 * (layer/mouse key)" holds a layer and taps a button, and no amount of UI
 * changes that. What the UI can do is show which pairings the board actually
 * offers, so "I want to hold Shift and tap a number" becomes a question with a
 * visible answer instead of a dead end.
 */
export function pairings(behaviors) {
  return [...behaviors.values()]
    .map((b) => {
      const set = b.metadata?.[0] ?? {};
      const i1 = paramInfo(set.param1);
      const i2 = paramInfo(set.param2);
      return { id: b.id, name: b.display_name || `#${b.id}`, i1, i2 };
    })
    .filter((p) => p.i1.kind !== "none" && p.i2.kind !== "none")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * "MB5" is the firmware's own shorthand and means nothing on its own, so say
 * what it does as well. Only where the translation is certain: a constant
 * named MB<n> whose value is a known button mask.
 */
export function constantLabel(option) {
  const friendly = MOUSE_BUTTONS[option.constant];
  if (friendly && /^mb\d/i.test(option.name ?? "")) return `${option.name} — ${friendly}`;
  return option.name || String(option.constant);
}

/** The same value, short enough to sit on a key cap. */
export function paramShort(info, value, layers) {
  if (info.kind === "none") return null;
  if (info.kind === "layer") return layers?.[value]?.name || `L${value}`;
  if (info.kind === "constant") {
    const found = info.options.find((o) => o.constant === value);
    return MOUSE_BUTTONS[value] ?? found?.name ?? String(value);
  }
  if (info.kind === "range") return String(value);
  return usageShort(value) ?? String(value);
}

/** Render one parameter's current value the way its own type reads. */
export function paramValueName(info, value, layers) {
  if (info.kind === "none") return null;
  if (info.kind === "layer") {
    const l = layers?.[value];
    return l?.name ? `${value} — ${l.name}` : `Layer ${value}`;
  }
  if (info.kind === "constant") {
    const found = info.options.find((o) => o.constant === value);
    return found ? constantLabel(found) : String(value);
  }
  if (info.kind === "range") return String(value);
  return usageName(value) ?? String(value);
}

/** One parameter, as whatever control its own description calls for. */
function ParamField({ id, label, info, value, onChange, layers }) {
  if (info.kind === "none") return null;

  if (info.kind === "constant") {
    return (
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={id}>{label}</label>
        <select id={id} className="search search--slim" value={value}
                onChange={(e) => onChange(Number(e.target.value))}>
          {info.options.map((c) => (
            <option key={c.constant} value={c.constant}>{constantLabel(c)}</option>
          ))}
        </select>
      </div>
    );
  }

  // A layer is an index into this keymap, so offer the layers by name rather
  // than asking for a number and hoping you remember which one is which.
  if (info.kind === "layer") {
    return (
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={id}>{label}</label>
        {layers?.length ? (
          <select id={id} className="search search--slim" value={value}
                  onChange={(e) => onChange(Number(e.target.value))}>
            {layers.map((l, i) => (
              <option key={l.id ?? i} value={i}>{i} — {l.name || `Layer ${i}`}</option>
            ))}
          </select>
        ) : (
          <input id={id} type="number" className="search search--slim" min={0}
                 value={value} onChange={(e) => onChange(Number(e.target.value))} />
        )}
      </div>
    );
  }

  if (info.kind === "range") {
    return (
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={id}>{label}</label>
        <input id={id} type="number" className="search search--slim"
               min={info.range.min} max={info.range.max} value={value}
               onChange={(e) => onChange(Number(e.target.value))} />
      </div>
    );
  }

  const known = ALL_CHOICES.some((c) => c.param === value);
  return (
    <>
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={id}>{label}</label>
        <select id={id} className="search search--slim" value={known ? value : ""}
                onChange={(e) => onChange(Number(e.target.value))}>
          <option value="">{known ? "—" : `custom (${value})`}</option>
          {CHOICE_GROUPS.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((c) => <option key={c.param} value={c.param}>{c.name}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      {!known && value !== 0 && (
        <div className="ctl ctl--inline">
          <label className="ctl__label" htmlFor={`${id}-raw`}>{label} — raw value</label>
          <input id={`${id}-raw`} type="number" className="search search--slim" value={value}
                 onChange={(e) => onChange(Number(e.target.value))} />
        </div>
      )}
    </>
  );
}

/** Choose what one key does: a behavior, and whatever parameters it takes. */
function Picker({ position, behaviors, binding, busy, onCancel, onPick, layers }) {
  // Sorted by name, because the board's own order is its internal table and
  // hunting for "Key Press" through sixty-six unsorted entries is what made
  // binding a volume key feel impossible.
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
  const set = chosen?.metadata?.[0] ?? {};
  const i1 = paramInfo(set.param1);
  const i2 = paramInfo(set.param2);
  const pairs = pairings(behaviors);

  // A hold-tap's two halves are "held" and "tapped" whatever they hold. Any
  // other behavior takes the parameter's own name when it has one — but never
  // a constant's name, which is a value like MB1 rather than a label.
  const holdTap = /hold\s*[/-]?\s*tap/i.test(chosen?.display_name ?? "");
  const nameFor = (descs, info, fallback) => {
    if (info.kind === "constant") return fallback;
    const named = descs?.find((d) => d.name)?.name;
    return named ? named[0].toUpperCase() + named.slice(1) : fallback;
  };
  const label1 = holdTap ? "When held" : nameFor(set.param1, i1, "Sends");
  const label2 = holdTap ? "When tapped" : nameFor(set.param2, i2, "Then");

  const preview = [
    i1.kind !== "none" ? `${label1}: ${paramValueName(i1, param1, layers)}` : null,
    i2.kind !== "none" ? `${label2}: ${paramValueName(i2, param2, layers)}` : null,
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

      <ParamField id="pick-p1" label={label1} info={i1} layers={layers}
                  value={param1} onChange={setParam1} />
      <ParamField id="pick-p2" label={label2} info={i2} layers={layers}
                  value={param2} onChange={setParam2} />

      {i1.kind !== "none" && i2.kind !== "none" && (
        <>
          <p className="ctl__hint">
            This one {holdTap ? "holds" : "takes"} {TYPE_WORD[i1.kind]} and{" "}
            {holdTap ? "taps" : "then"} {TYPE_WORD[i2.kind]}. Those types are
            fixed in the firmware. To pair different ones, use a behavior that
            offers them:
          </p>
          <div className="row row--wrap">
            {pairs.map((p) => (
              <button
                key={p.id}
                className={"pill" + (p.id === id ? " is-active" : "")}
                title={`${p.name}: ${TYPE_WORD[p.i1.kind]} then ${TYPE_WORD[p.i2.kind]}`}
                onClick={() => { setId(p.id); setParam1(0); setParam2(0); }}
              >
                {TYPE_WORD[p.i1.kind]} + {TYPE_WORD[p.i2.kind]}
              </button>
            ))}
          </div>
        </>
      )}
      {i1.kind === "none" && i2.kind === "none" && (
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
