import { useCallback, useEffect, useRef, useState } from "react";
import {
  Request, Response, decode, encode, frame, subsystemOf, tinyKeys, unframer,
  LOCKED, UNLOCKED, META_ERRORS,
} from "./studio.js";
import {
  ALL_CHOICES, CHOICE_GROUPS, KEY_TYPES, MOUSE_BUTTONS,
  keyType, usageGroup, usageName, usageShort,
} from "./keycodes.js";
import Loading from "./Loading.jsx";
import Sofle from "./Sofle.jsx";

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
 * appear as two ports with the same name — which numbers or paths they get is
 * up to the machine and changes between one computer and the next, so it is
 * not something to hard-code or to ask a person to know. Try each port already
 * granted, ask it who it is, and keep the one that answers.
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

/** UNLOCK_REQUIRED from zmk/meta.proto. */
const ERR_LOCKED = 1;
/**
 * A binding, as everything the UI needs to say about it.
 *
 * One pass, because the cap, the colour, the tooltip and the accessible name
 * all have to agree, and they can only be guaranteed to agree if one function
 * decides them together from the same parameter metadata.
 */
function describe(binding, behaviors, layers) {
  const nothing = {
    name: "—", action: null, type: "none", full: "Unbound", detail: null,
    rows: [["Action", "Unbound"]],
  };
  if (!binding || Object.keys(binding).length === 0) return nothing;
  const id = binding.behavior_id ?? 0;
  const b = behaviors.get(id);
  const name = b?.display_name ?? `#${id}`;
  const p1 = binding.param1 ?? 0;
  const p2 = binding.param2 ?? 0;
  const meta = b?.metadata?.[0] ?? {};
  const i1 = paramInfo(meta.param1);
  const i2 = paramInfo(meta.param2);

  // A colour is one word, so a parameter's kind decides it before its value
  // does — a layer is a layer whatever number it holds, and a constant is a
  // mouse button only when its value is a button mask.
  const typeOf = (info, value) => {
    if (info.kind === "none") return "none";
    if (info.kind === "layer") return "layer";
    if (info.kind === "constant") return MOUSE_BUTTONS[value] ? "mouse" : "other";
    if (info.kind === "range") return "other";
    return keyType(value);
  };
  const groupOf = (info, value) => {
    if (info.kind === "layer") return "Layer";
    if (info.kind === "constant") return MOUSE_BUTTONS[value] ? "Mouse" : null;
    if (info.kind === "usage") return usageGroup(value);
    return null;
  };
  const typeWord = (slug) => KEY_TYPES.find(([t]) => t === slug)?.[1] ?? null;

  // A key that sends one thing reads as that thing — and what that thing is
  // comes from the parameter's own declaration, never from the behavior's
  // name. Matching names is a guess about one firmware's naming habits dressed
  // up as a rule, and it is how "Hold/tap (layer/mouse key)" got its layer read
  // as a mouse button.
  if (p1 && i1.kind !== "none" && i2.kind === "none") {
    const type = typeOf(i1, p1);
    return {
      name: paramShort(i1, p1, layers),
      action: name,
      type,
      full: paramValueName(i1, p1, layers),
      detail: name,
      rows: [
        ["Action", name],
        ["Sends", paramValueName(i1, p1, layers)],
        ["Type", groupOf(i1, p1) ?? typeWord(type)],
      ],
    };
  }

  // Two parameters: the cap shows the values, not the behavior's name. Knowing
  // a key is a hold/tap without knowing which layer or which key it holds and
  // taps is the least useful thing the cap could say.
  // Wording only. Nothing is parsed from the name, so a firmware that calls
  // its behavior something else loses the words "hold" and "tap" and keeps
  // every value.
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
    // The colour follows the cap for the same reason.
    const type = typeOf(i2, p2);
    return {
      name: paramShort(i2, p2, layers),
      sub: `hold ${paramShort(i1, p1, layers)}`,
      action: name,
      type,
      full: `${name} — ${parts.join(", ")}`,
      detail: null,
      rows: [
        ["Action", name],
        [holdTap ? "Tap" : "Then", paramValueName(i2, p2, layers)],
        [holdTap ? "Hold" : "First", paramValueName(i1, p1, layers)],
        ["Type", groupOf(i2, p2) ?? typeWord(type)],
      ],
    };
  }
  const rows = [["Action", name], ...(parts.length ? [["Sends", parts.join(", ")]] : [])];
  if (parts.length) return { name, action: name, type: "other", full: `${name} — ${parts.join(", ")}`, detail: null, rows };
  // No parameters at all: the behavior's name is the whole story, so it is the
  // cap rather than a caption above an empty one.
  return { name, action: null, type: "other", full: name, detail: null, rows };
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
  const [layerName, setLayerName] = useState("");
  // Which key the pointer is over, for the detail card. Kept out of `picking`
  // deliberately: hovering must not disturb what you are part-way through
  // editing, and the card has to be able to appear over a key while a
  // different one is open in the picker.
  const [hover, setHover] = useState(null);
  // A board is drawn to fit by default. Zoom is for the boards that fit badly
  // — forty keys on a wide screen leave a lot of room, and a hundred-key board
  // on a laptop leaves none.
  const [zoom, setZoom] = useState(1);
  // Drawn as a board rather than as a diagram. Only offered where the shape has
  // been looked at, and remembered per session rather than per board.
  const [solid, setSolid] = useState(true);

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
    // Whatever we were holding goes first. A link left open keeps its writer,
    // and findRpcPort then skips that port as "in use" while requestPort hands
    // it straight back — so the new Link asks for a writer the old one still
    // has, and getWriter throws on a locked stream. Closing here rather than in
    // the failure path is what makes it true on every route in.
    await link.current?.close();
    link.current = null;
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

  const disconnect = async () => {
    await link.current?.close();
    link.current = null;
    setState("idle");
  };

  /**
   * After unlocking: ask again on the link we already have.
   *
   * A lock refuses the request, not the connection — the port is open and
   * working, so reconnecting would close a good link and reopen it for no
   * reason. Only when there is nothing open does this fall back to connecting.
   */
  const retryAfterUnlock = async () => {
    setLockSeen(true);
    if (!link.current?.open) { connect(false); return; }
    setState("opening");
    try {
      await load();
      setLocked(false);
      setState("ready");
    } catch (err) {
      if (err?.code === ERR_LOCKED) { setLockSeen(false); setState("idle"); return; }
      await link.current?.close();
      link.current = null;
      setState("idle");
      onNote?.(String(err?.message ?? err));
    }
  };

  useEffect(() => () => { link.current?.close(); }, []);

  // Follow the selected layer, so the field never offers to rename one layer
  // with another's name still sitting in it.
  useEffect(() => {
    setLayerName(keymap?.layers?.[layer]?.name ?? "");
  }, [keymap, layer]);

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

  /**
   * Layers: add, rename, remove.
   *
   * The RPC has had these all along and the editor only ever read layers. A
   * keymap you can edit but not restructure is half a tool — and every one of
   * these goes through the same unsaved-changes flow as a binding, so nothing
   * reaches storage until Save.
   */
  const addLayer = async () => {
    setBusy(true);
    try {
      const res = await link.current.call("keymap", { add_layer: {} });
      const err = res.add_layer?.err;
      if (err) {
        onNote?.(err === 2 ? "The board has no room for another layer." : "The board could not add a layer.");
        return;
      }
      await load();
      const at = res.add_layer?.ok?.index;
      if (at !== undefined) setLayer(at);
      onNote?.("Layer added. Save writes it to the board.");
    } catch (e) {
      if (e?.code === ERR_LOCKED) { setLocked(true); setLockSeen(false); }
      else onNote?.(String(e?.message ?? e));
    } finally { setBusy(false); }
  };

  const renameLayer = async (name) => {
    const l = keymap?.layers?.[layer];
    if (!l) return;
    setBusy(true);
    try {
      const res = await link.current.call("keymap", {
        set_layer_props: { layer_id: l.id ?? 0, name },
      });
      if (res.set_layer_props) { onNote?.("The board refused that name."); return; }
      await load();
      onNote?.(`Layer renamed to "${name}". Save writes it to the board.`);
    } catch (e) {
      if (e?.code === ERR_LOCKED) { setLocked(true); setLockSeen(false); }
      else onNote?.(String(e?.message ?? e));
    } finally { setBusy(false); }
  };

  const removeLayer = async () => {
    if (!keymap?.layers?.length) return;
    setBusy(true);
    try {
      const res = await link.current.call("keymap", {
        remove_layer: { layer_index: layer },
      });
      const err = res.remove_layer?.err;
      if (err) {
        onNote?.(err === 2 ? "That layer index is not one the board knows." : "The board could not remove that layer.");
        return;
      }
      // The list just got shorter under us, so step back rather than pointing
      // at a layer that is no longer there.
      setLayer((i) => Math.max(0, i - 1));
      setPicking(null);
      await load();
      onNote?.("Layer removed. Save writes it to the board.");
    } catch (e) {
      if (e?.code === ERR_LOCKED) { setLocked(true); setLockSeen(false); }
      else onNote?.(String(e?.message ?? e));
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
          <button className="btn btn--primary" onClick={retryAfterUnlock}>
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
  // Both the board and the list under it ask which keys are too small to
  // label, and they used to ask it differently: the board measured the key
  // against the board's width, the list took whatever the ring left over. On a
  // trackball those agree, because the leftovers are the encoder slivers. On a
  // keyboard where every key is the same size the ring keeps eight and the
  // list claimed the other fifty-two were too small to draw — while the board
  // had just drawn them, legibly, right above the claim.
  const tinies = tinyKeys(keys);

  const activeLayout = layouts?.active_layout_index ?? 0;
  // The 3D view builds itself from the reported layout, so it would draw any
  // board — but "would draw" is not "has been looked at", and a case swept
  // around a shape nobody has seen is a good way to ship a puddle. Sofle is the
  // one that has been, so Sofle is the one that gets offered it.
  const canSolid = /sofle/i.test(layout?.name ?? "");
  const solidView = canSolid && solid;
  // Cap and colour only. The hold line, the behavior name and the type dot are
  // a flat-board affordance; a keycap gets a legend.
  const legends = keys.map((_, position) => {
    const b = describe(current?.bindings?.[position], behaviors, keymap?.layers);
    return { cap: b.name, type: b.type };
  });
  // Only the types this layer actually uses. A legend listing ten colours
  // where the board shows three is decoration; one that matches what is on
  // screen is a key to it.
  const typesHere = new Set((current?.bindings ?? [])
    .map((binding) => describe(binding, behaviors, keymap?.layers).type)
    .filter((t) => t !== "none"));

  const hovered = hover !== null ? keys[hover] : null;
  const hoverInfo = hover !== null
    ? describe(current?.bindings?.[hover], behaviors, keymap?.layers) : null;
  // Near the top of the board there is no room above the key, so the card
  // drops below it instead of hanging off the frame.
  const cardBelow = hovered ? ((hovered.y ?? 0) - bounds.minY) / spanY < 0.28 : false;

  return (
    <div className="editor">
      <aside className="editor__rail">
        <h3 className="sec">Layouts</h3>
        <ul className="rail__list">
          {(layouts?.layouts ?? []).map((l, i) => (
            <li key={i}>
              <span className={"rail__item" + (i === activeLayout ? " is-active" : "")}>
                <span className="rail__name">{l.name || `Layout ${i}`}</span>
                <span className="rail__meta">{l.keys?.length ?? 0} keys</span>
              </span>
            </li>
          ))}
          {!layouts?.layouts?.length && (
            <li><span className="rail__item"><span className="rail__meta">none reported</span></span></li>
          )}
        </ul>

        <h3 className="sec">Layers</h3>
        <ul className="rail__list">
          {(keymap?.layers ?? []).map((l, i) => (
            <li key={l.id ?? i}>
              <button
                className={"rail__item" + (i === layer ? " is-active" : "")}
                onClick={() => { setLayer(i); setPicking(null); }}
              >
                <span className="rail__name">{l.name || `Layer ${i}`}</span>
                <span className="rail__meta">L{i}</span>
              </button>
            </li>
          ))}
        </ul>
        {/* The board says how many it can hold, so the button goes when there
            is no room rather than offering something that will be refused. */}
        {(keymap?.available_layers ?? 0) > 0 && (
          <button className="rail__add" onClick={addLayer} disabled={busy}>+ Add layer</button>
        )}

        <div className="rail__form">
          <label className="ctl__label" htmlFor="layer-name">Layer name</label>
          <input
            id="layer-name"
            className="search search--slim"
            value={layerName}
            maxLength={keymap?.max_layer_name_length || undefined}
            placeholder={current?.name || `Layer ${layer}`}
            onChange={(e) => setLayerName(e.target.value)}
          />
          <div className="row row--wrap">
            <button
              className="btn"
              disabled={busy || !layerName.trim() || layerName.trim() === (current?.name ?? "")}
              onClick={() => renameLayer(layerName.trim())}
            >
              Rename
            </button>
            <button
              className="btn btn--danger"
              disabled={busy || (keymap?.layers?.length ?? 0) < 2}
              onClick={removeLayer}
              title={(keymap?.layers?.length ?? 0) < 2
                ? "A keymap needs at least one layer"
                : "Remove this layer"}
            >
              Remove
            </button>
          </div>
        </div>

        {typesHere.size > 1 && (
          <>
            <h3 className="sec">Key types</h3>
            <ul className="legend">
              {/* Letters are deliberately uncoloured, so listing them here
                  would be a blank swatch beside a word. */}
              {KEY_TYPES.filter(([slug]) => slug !== "letter" && typesHere.has(slug))
                .map(([slug, label]) => (
                <li key={slug} className="legend__item">
                  <span className="legend__swatch" data-type={slug} />
                  {label}
                </li>
                ))}
            </ul>
          </>
        )}

        <div className="rail__foot">
          <div className="row row--wrap">
            <span className="chip chip--live">{device?.name || "connected"}</span>
            {locked && <span className="chip">locked</span>}
            {dirty && <span className="chip">unsaved</span>}
          </div>
          <button className="btn btn--ghost" onClick={disconnect}>Disconnect editor</button>
        </div>
      </aside>

      <div className="editor__main">
        {lockDialog}

        {locked && lockSeen && (
          <p className="warn warn--inline">
            Still locked — press the studio-unlock key on the board.
          </p>
        )}

        <div className="kmap__bar">
          <h3 className="sec sec--flush">Key bindings</h3>
          <span className="actions__gap" />
          {canSolid && (
            <div className="zoom" role="group" aria-label="How to draw the board">
              <button className={"zoom__btn" + (solidView ? " is-active" : "")}
                      onClick={() => setSolid(true)} aria-pressed={solidView}>3D</button>
              <button className={"zoom__btn" + (solidView ? "" : " is-active")}
                      onClick={() => setSolid(false)} aria-pressed={!solidView}>Flat</button>
            </div>
          )}
          {/* The 3D view zooms on its own wheel, so this would be a second
              control for the same thing pointing at the wrong one. */}
          <div className="zoom" role="group" aria-label="Board size" hidden={solidView}>
            <button
              className="zoom__btn"
              onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(2)))}
              disabled={zoom <= 0.6}
              aria-label="Smaller"
            >
              &minus;
            </button>
            <button className="zoom__now" onClick={() => setZoom(1)} title="Back to fit">
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="zoom__btn"
              onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2)))}
              disabled={zoom >= 3}
              aria-label="Bigger"
            >
              +
            </button>
          </div>
        </div>

        {layout && solidView && (
          <>
            <Sofle
              keys={keys}
              labels={legends}
              active={picking}
              onPick={(position) => setPicking(picking === position ? null : position)}
              // What the nice!views show. The reference painted battery,
              // Bluetooth profiles and words per minute; none of that reaches
              // this app, and a drawn battery reading is worse than no reading.
              // These four are things the editor actually knows.
              info={{
                device: device?.name ?? "ZMK",
                layer: current?.name ?? `Layer ${layer}`,
                index: layer,
                layers: keymap?.layers?.length ?? 1,
                keys: keys.length,
                dirty,
              }}
            />
            <p className="ctl__hint">
              Drag to look around, wheel to zoom, click a key to change it. The
              case is swept around the key positions this board reported, so it
              is the shape of your layout rather than a picture of someone
              else's.
            </p>
          </>
        )}

        {layout && !solidView ? (
          <div className="kmap__wrap">
            <div className="kmap" style={{ aspectRatio: `${spanX} / ${spanY}`, width: `${zoom * 100}%` }}>
              {keys.map((k, position) => {
                const b = describe(current?.bindings?.[position], behaviors, keymap?.layers);
                const w = k.width ?? 100;
                const h = k.height ?? 100;
                // Type scaled to the key it sits in, in container units so it
                // follows the board's own width. A narrow encoder key gets small
                // type rather than a clipped label. The factor is read directly:
                // container units cancel the board's width out, so 0.32 is 32% of
                // this key's own width, whatever size the board is drawn at.
                //
                // A hold-tap prints two values and a behavior name in the space
                // a plain key gives to one, so it takes the smaller type. Sized
                // for one and it overflowed the cap — which is a thing you only
                // see on the keys that carry the most information.
                //
                // And a name is sized to its own length. 30% of the key is right
                // for "A" and absurd for "Output Selection", which at glyph size
                // needs three lines a keycap does not have — so the long ones
                // step down until they fit, and stop stepping at ten characters
                // so the genuinely long ones wrap rather than shrink away.
                //
                // 0.78em per character is deliberately more than the font
                // actually needs. The budget is the key, and the key is the
                // cell less a gutter each side and its own padding — which is a
                // fifth of a 50px keycap and nothing at all on a 200px one, so
                // a figure tuned on a wide board put "None" on two lines on a
                // narrow one. The slack is that difference.
                //
                // The hold line is sized separately rather than as a fraction
                // of the cap. Sharing one size meant "hold Ctrl+V" — eleven
                // characters — decided the size of the "V" above it, so the
                // letter you actually press was drawn small on a key with room
                // to spare. They are two different pieces of information at two
                // different sizes; the tap is the one you read.
                const chars = Math.max(2, Math.min((b.name ?? "").length, 11));
                const size = ((w / spanX) * 100
                  * Math.min(b.sub ? 0.28 : 0.30, 1 / (chars * 0.78))).toFixed(2);
                const subChars = Math.max(4, Math.min((b.sub ?? "").length, 16));
                const subSize = ((w / spanX) * 100
                  * Math.min(0.13, 1 / (subChars * 0.72))).toFixed(2);
                const tiny = tinies.has(position);
                return (
                  <button
                    key={position}
                    className={"kmap__key"
                      + (picking === position ? " is-active" : "")
                      + (tiny ? " kmap__key--tiny" : "")}
                    data-type={b.type}
                    style={{
                      // Inset by half a gutter on every side. A physical layout
                      // gives each key its whole unit — 100 wide means one full
                      // key unit — so drawing keys at their stated size leaves
                      // no space between them and the board reads as a grid of
                      // touching rectangles rather than as keys.
                      left: `calc(${((k.x ?? 0) - bounds.minX + PAD) / spanX * 100}% + var(--gut))`,
                      top: `calc(${((k.y ?? 0) - bounds.minY + PAD) / spanY * 100}% + var(--gut))`,
                      width: `calc(${(w / spanX) * 100}% - var(--gut) * 2)`,
                      height: `calc(${(h / spanY) * 100}% - var(--gut) * 2)`,
                      fontSize: `clamp(8px, ${size}cqw, 26px)`,
                      transform: k.r ? `rotate(${k.r / 100}deg)` : undefined,
                    }}
                    title={b.detail ? `${b.full} · ${b.detail}` : b.full}
                    onClick={() => setPicking(picking === position ? null : position)}
                    onMouseEnter={() => setHover(position)}
                    onMouseLeave={() => setHover((at) => (at === position ? null : at))}
                    onFocus={() => setHover(position)}
                    onBlur={() => setHover((at) => (at === position ? null : at))}
                  >
                    {tiny ? <span className="kmap__dot" aria-hidden="true" /> : (
                      <>
                        {b.action && <span className="kmap__action">{b.action}</span>}
                        <span className="kmap__cap">{b.name}</span>
                        {b.sub && (
                          <span className="kmap__sub"
                                style={{ fontSize: `clamp(6px, ${subSize}cqw, 13px)` }}>
                            {b.sub}
                          </span>
                        )}
                      </>
                    )}
                    {tiny && <span className="sr-only">{b.full}</span>}
                  </button>
                );
              })}

              {/* What the key is, spelled out. The cap has room for a glyph and
                  a hold line; everything else — which behavior, which of its
                  halves is which, what kind of key it sends — lives here. */}
              {hovered && hoverInfo && (
                <div
                  className="keycard"
                  role="presentation"
                  data-below={cardBelow ? "" : undefined}
                  style={{
                    left: `${((hovered.x ?? 0) - bounds.minX + PAD + (hovered.width ?? 100) / 2) / spanX * 100}%`,
                    top: `${((hovered.y ?? 0) - bounds.minY + PAD
                      + (cardBelow ? (hovered.height ?? 100) : 0)) / spanY * 100}%`,
                  }}
                >
                  <dl className="keycard__rows">
                    {hoverInfo.rows.filter(([, v]) => v).map(([label, value]) => (
                      <div className="keycard__row" key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {!layout && (
          <p className="ctl__hint">
            This board reports no physical layout, so its keys cannot be drawn in
            position. The bindings are still listed below.
          </p>
        )}

        {layout && !solidView && (() => {
          // Grouped by encoder, not by layout order. Listing them in raw position
          // order put Volume Up, then the other wheel, then Volume Down — the two
          // halves of one encoder split by an unrelated key.
          const small = wheelOrder(keys).flat()
            .filter((position) => tinies.has(position))
            .map((position) => ({ position }));
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
                      data-type={b.type}
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
                  <button className="pill" data-type={b.type} onClick={() => setPicking(position)}>
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
            Save to board
          </button>
          <button className="btn" onClick={discard} disabled={busy}>Discard</button>
          <span className="actions__gap" />
          <button className="btn btn--ghost" onClick={load} disabled={busy}>Re-read</button>
        </div>
      </div>
    </div>
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

  return <KeycodeGrid id={id} label={label} value={value} onChange={onChange} />;
}

/**
 * Every bindable usage, laid out and coloured the way it is on the board.
 *
 * This was a `<select>`. One hundred and seventy-two options behind a dropdown
 * is a list you can only use if you already know what you are looking for, and
 * it gave no sense of what a board can do — which is most of what someone
 * opening a keymap editor for the first time is trying to find out. Laid out
 * flat, grouped and coloured by the same types the keycaps use, it answers
 * "what can I put here" by being looked at.
 */
function KeycodeGrid({ id, label, value, onChange }) {
  const [q, setQ] = useState("");
  const known = ALL_CHOICES.some((c) => c.param === value);
  const needle = q.trim().toLowerCase();
  const groups = CHOICE_GROUPS
    .map((g) => ({
      group: g.group,
      items: needle ? g.items.filter((c) => c.name.toLowerCase().includes(needle)) : g.items,
    }))
    .filter((g) => g.items.length);
  const found = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="codes">
      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor={`${id}-find`}>{label}</label>
        <input
          id={`${id}-find`}
          type="search"
          className="search search--slim"
          placeholder={`Search ${ALL_CHOICES.length} keys`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* A binding this app has no name for is still a binding. Showing the
          number and letting it be typed is the difference between "we cannot
          display this" and "we cannot change this". */}
      {!known && value !== 0 && (
        <div className="ctl ctl--inline">
          <label className="ctl__label" htmlFor={`${id}-raw`}>Not a key this app knows — raw value</label>
          <input id={`${id}-raw`} type="number" className="search search--slim" value={value}
                 onChange={(e) => onChange(Number(e.target.value))} />
        </div>
      )}

      <div className="codes__scroll">
        {groups.map((g) => (
          <div className="codes__group" key={g.group}>
            <h5 className="codes__title">{g.group} <span className="codes__count">{g.items.length}</span></h5>
            <div className="codes__grid">
              {g.items.map((c) => (
                <button
                  key={c.param}
                  type="button"
                  className={"code" + (c.param === value ? " is-active" : "")}
                  data-type={keyType(c.param)}
                  title={c.name}
                  onClick={() => onChange(c.param)}
                >
                  {usageShort(c.param) ?? c.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        {!found && <p className="ctl__hint">Nothing matches “{q}”.</p>}
      </div>
    </div>
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
