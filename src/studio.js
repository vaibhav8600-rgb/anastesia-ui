// ZMK Studio RPC, spoken directly.
//
// The Zephyr shell this app otherwise uses cannot touch a single key binding.
// The keymap module registers init/status/save/overwrite/activate/destroy/
// restore/free/assign, and every one of them works on a whole keymap slot.
// Bindings live behind Studio's RPC, which is a different protocol on a
// different USB interface, so this file implements it: framing, protobuf, and
// the handful of messages a keymap editor needs.
//
// Schema: zmkfirmware/zmk-studio-messages @ 6cb4c28, which is what ZMK v0.3.0
// pins. Nothing here is generated — the message set is small enough to declare
// as data, and a generator would have been a build step and a dependency.

// ---------------------------------------------------------------- framing
// zmk/app/src/studio/msg_framing.h. A frame is SOF, escaped payload, EOF; any
// payload byte equal to one of the three is preceded by ESC.
const SOF = 0xab;
const ESC = 0xac;
const EOF = 0xad;

export function frame(payload) {
  const out = [SOF];
  for (const b of payload) {
    if (b === SOF || b === ESC || b === EOF) out.push(ESC);
    out.push(b);
  }
  out.push(EOF);
  return Uint8Array.from(out);
}

/**
 * Feed bytes in, get whole payloads out. Kept as a closure rather than a class
 * because it is one variable of state and a method.
 */
export function unframer() {
  let buf = [];
  let inFrame = false;
  let escaped = false;
  return function push(bytes) {
    const frames = [];
    for (const b of bytes) {
      if (escaped) { buf.push(b); escaped = false; continue; }
      if (b === ESC) { escaped = true; continue; }
      if (b === SOF) { inFrame = true; buf = []; continue; }
      if (b === EOF) {
        if (inFrame) frames.push(Uint8Array.from(buf));
        inFrame = false; buf = [];
        continue;
      }
      // Bytes outside a frame are the board's own logging on a shared port.
      if (inFrame) buf.push(b);
    }
    return frames;
  };
}

// --------------------------------------------------------------- protobuf
// Only what proto3 needs here: varints, length-delimited, and the zigzag that
// sint32 uses. No fixed32/64 appears anywhere in the Studio schema.

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

function writeVarint(out, n) {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;          // negative int32 is sign-extended to 64 bits
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
}

const zigzag = (n) => (n << 1) ^ (n >> 31);
const unzigzag = (n) => (n >>> 1) ^ -(n & 1);

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  get done() { return this.i >= this.b.length; }
  varint() {
    let shift = 0n, result = 0n;
    for (;;) {
      const byte = this.b[this.i++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }
  bytes() {
    const len = Number(this.varint());
    const out = this.b.subarray(this.i, this.i + len);
    this.i += len;
    return out;
  }
  skip(wire) {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_LEN) this.bytes();
    else if (wire === 5) this.i += 4;
    else if (wire === 1) this.i += 8;
    else throw new Error(`unknown wire type ${wire}`);
  }
}

const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

/**
 * A message schema is { fieldName: [tag, kind] } and, for messages, a third
 * entry naming the nested schema. `repeated` is a kind prefix rather than a
 * flag so the tables stay one line per field.
 */
export function encode(schema, value) {
  const out = [];
  for (const [name, [tag, kind, sub]] of Object.entries(schema)) {
    const v = value?.[name];
    if (v === undefined || v === null) continue;
    const items = kind.startsWith("repeated ") ? v : [v];
    const base = kind.replace("repeated ", "");
    for (const item of items) {
      if (base === "message") {
        const body = encode(sub, item);
        out.push((tag << 3) | WIRE_LEN); writeVarint(out, body.length);
        out.push(...body);
      } else if (base === "string" || base === "bytes") {
        const body = base === "string" ? utf8.enc.encode(item) : item;
        out.push((tag << 3) | WIRE_LEN); writeVarint(out, body.length);
        out.push(...body);
      } else {
        out.push((tag << 3) | WIRE_VARINT);
        writeVarint(out, base === "sint32" ? zigzag(item) : base === "bool" ? (item ? 1 : 0) : item);
      }
    }
  }
  return Uint8Array.from(out);
}

export function decode(schema, bytes) {
  const byTag = new Map();
  for (const [name, spec] of Object.entries(schema)) byTag.set(spec[0], [name, spec]);
  const out = {};
  const r = new Reader(bytes);
  while (!r.done) {
    const key = Number(r.varint());
    const tag = key >>> 3, wire = key & 7;
    const found = byTag.get(tag);
    if (!found) { r.skip(wire); continue; }
    const [name, [, kind, sub]] = found;
    const repeated = kind.startsWith("repeated ");
    const base = kind.replace("repeated ", "");
    let v;
    if (base === "message") v = decode(sub, r.bytes());
    else if (base === "string") v = utf8.dec.decode(r.bytes());
    else if (base === "bytes") v = Uint8Array.from(r.bytes());
    else {
      const n = r.varint();
      // int32/uint32 come back inside 64 bits; take the low half, then read it
      // as signed where the field says so.
      const low = Number(BigInt.asUintN(32, n));
      v = base === "sint32" ? unzigzag(low)
        : base === "int32" ? (low | 0)
          : base === "bool" ? low !== 0
            : low;
    }
    if (repeated) (out[name] ??= []).push(v);
    else out[name] = v;
  }
  return out;
}

// --------------------------------------------------------------- messages
// Declared in the order the .proto files declare them, so a diff against
// upstream is a straight read.

export const BehaviorBinding = {
  behavior_id: [1, "sint32"],
  param1: [2, "uint32"],
  param2: [3, "uint32"],
};

export const Layer = {
  id: [1, "uint32"],
  name: [2, "string"],
  bindings: [3, "repeated message", BehaviorBinding],
};

export const Keymap = {
  layers: [1, "repeated message", Layer],
  available_layers: [2, "uint32"],
  max_layer_name_length: [3, "uint32"],
};

export const KeyPhysicalAttrs = {
  width: [1, "sint32"], height: [2, "sint32"],
  x: [3, "sint32"], y: [4, "sint32"],
  r: [5, "sint32"], rx: [6, "sint32"], ry: [7, "sint32"],
};

export const PhysicalLayout = {
  name: [1, "string"],
  keys: [2, "repeated message", KeyPhysicalAttrs],
};

export const PhysicalLayouts = {
  active_layout_index: [1, "uint32"],
  layouts: [2, "repeated message", PhysicalLayout],
};

export const SetLayerBindingRequest = {
  layer_id: [1, "uint32"],
  key_position: [2, "int32"],
  binding: [3, "message", BehaviorBinding],
};

export const SetLayerPropsRequest = {
  layer_id: [1, "uint32"],
  name: [2, "string"],
};

const KeymapRequest = {
  get_keymap: [1, "bool"],
  set_layer_binding: [2, "message", SetLayerBindingRequest],
  check_unsaved_changes: [3, "bool"],
  save_changes: [4, "bool"],
  discard_changes: [5, "bool"],
  get_physical_layouts: [6, "bool"],
  add_layer: [9, "message", {}],
  remove_layer: [10, "message", { layer_index: [1, "uint32"] }],
  set_layer_props: [12, "message", SetLayerPropsRequest],
};

const SaveChangesResponse = { ok: [1, "bool"], err: [2, "uint32"] };
const AddLayerResponseDetails = { index: [1, "uint32"], layer: [2, "message", Layer] };
const AddLayerResponse = { ok: [1, "message", AddLayerResponseDetails], err: [2, "uint32"] };
const RemoveLayerResponse = { ok: [1, "message", {}], err: [2, "uint32"] };

const KeymapResponse = {
  get_keymap: [1, "message", Keymap],
  set_layer_binding: [2, "uint32"],
  check_unsaved_changes: [3, "bool"],
  save_changes: [4, "message", SaveChangesResponse],
  discard_changes: [5, "bool"],
  get_physical_layouts: [6, "message", PhysicalLayouts],
  add_layer: [9, "message", AddLayerResponse],
  remove_layer: [10, "message", RemoveLayerResponse],
  set_layer_props: [12, "uint32"],
};

const CoreRequest = {
  get_device_info: [1, "bool"],
  get_lock_state: [2, "bool"],
  lock: [3, "bool"],
  reset_settings: [4, "bool"],
};

const GetDeviceInfoResponse = { name: [1, "string"], serial_number: [2, "bytes"] };

const CoreResponse = {
  get_device_info: [1, "message", GetDeviceInfoResponse],
  get_lock_state: [2, "uint32"],
  reset_settings: [4, "bool"],
};

const BehaviorsRequest = {
  list_all_behaviors: [1, "bool"],
  get_behavior_details: [2, "message", { behavior_id: [1, "uint32"] }],
};

const ValueRange = { min: [1, "int32"], max: [2, "int32"] };
const HidUsage = { keyboard_max: [1, "uint32"], consumer_max: [2, "uint32"] };
const ParamDescription = {
  name: [1, "string"],
  nil: [2, "message", {}],
  constant: [3, "uint32"],
  range: [4, "message", ValueRange],
  hid_usage: [5, "message", HidUsage],
  layer_id: [6, "message", {}],
};
const ParametersSet = {
  param1: [1, "repeated message", ParamDescription],
  param2: [2, "repeated message", ParamDescription],
};
const GetBehaviorDetailsResponse = {
  id: [1, "uint32"],
  display_name: [2, "string"],
  metadata: [3, "repeated message", ParametersSet],
};

const BehaviorsResponse = {
  list_all_behaviors: [1, "message", { behaviors: [1, "repeated uint32"] }],
  get_behavior_details: [2, "message", GetBehaviorDetailsResponse],
};

const MetaResponse = { no_response: [1, "bool"], simple_error: [2, "uint32"] };

export const Request = {
  request_id: [1, "uint32"],
  core: [3, "message", CoreRequest],
  behaviors: [4, "message", BehaviorsRequest],
  keymap: [5, "message", KeymapRequest],
};

const RequestResponse = {
  request_id: [1, "uint32"],
  meta: [2, "message", MetaResponse],
  core: [3, "message", CoreResponse],
  behaviors: [4, "message", BehaviorsResponse],
  keymap: [5, "message", KeymapResponse],
};

const CoreNotification = { lock_state_changed: [1, "uint32"] };
const KeymapNotification = { unsaved_changes_status_changed: [1, "bool"] };
const Notification = {
  core: [2, "message", CoreNotification],
  keymap: [5, "message", KeymapNotification],
};

export const Response = {
  request_response: [1, "message", RequestResponse],
  notification: [2, "message", Notification],
};

export const LOCKED = 0;
export const UNLOCKED = 1;

export const META_ERRORS = {
  0: "The board refused the request.",
  1: "Locked — press the studio-unlock key on the board.",
  2: "This firmware does not implement that request.",
  3: "The board could not decode the request.",
  4: "The board could not encode its reply.",
};

/** Every response carries exactly one subsystem; find which. */
export function subsystemOf(rr) {
  for (const k of ["meta", "core", "behaviors", "keymap"]) if (rr?.[k]) return k;
  return null;
}

// ------------------------------------------------------------- self-check
// node src/studio.js

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("studio.js")) {
  const eq = (a, b, m) => console.assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}`);
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join(" ");

  // Framing: a payload byte that collides with a framing byte must be escaped,
  // or the board sees the frame end early.
  eq(hex(frame([0x01, 0x02])), "ab 01 02 ad", "plain payload");
  eq(hex(frame([SOF, ESC, EOF])), "ab ac ab ac ac ac ad ad", "every framing byte escaped");

  const push = unframer();
  eq(push(frame([1, 2, 3])).map(hex), ["01 02 03"], "one frame in, one out");
  eq(push(frame([SOF, EOF])).map(hex), ["ab ad"], "escapes survive the round trip");
  const split = unframer();
  const whole = frame([9, ESC, 9]);
  eq(split(whole.subarray(0, 2)).length, 0, "a partial frame yields nothing");
  eq(split(whole.subarray(2)).map(hex), ["09 ac 09"], "and completes on the rest");
  eq(unframer()([0x41, 0x42]).length, 0, "log noise outside a frame is dropped");

  // Protobuf against bytes computed by hand from the wire format.
  eq(hex(encode({ a: [1, "uint32"] }, { a: 300 })), "08 ac 02", "varint field");
  eq(hex(encode({ a: [1, "sint32"] }, { a: -1 })), "08 01", "sint32 zigzags");
  // tag byte, then the length, then the bytes — the length is the point of
  // "length-delimited" and leaving it out of the expectation was my error.
  eq(hex(encode({ a: [1, "string"] }, { a: "hi" })), "0a 02 68 69", "length-delimited string");
  eq(hex(encode({ a: [1, "bool"] }, { a: true })), "08 01", "bool");
  eq(hex(encode({ a: [1, "uint32"] }, {})), "", "an absent field writes nothing");

  // A binding is the message this whole file exists to send.
  const bindingBytes = encode(BehaviorBinding, { behavior_id: -3, param1: 7, param2: 0 });
  eq(decode(BehaviorBinding, bindingBytes), { behavior_id: -3, param1: 7, param2: 0 },
     "binding round-trips, negative behavior id included");

  // Nested and repeated together, which is every keymap reply.
  const km = { layers: [{ id: 1, name: "base", bindings: [{ behavior_id: 2, param1: 4 }] },
                        { id: 2, name: "fn", bindings: [] }],
               available_layers: 3 };
  const back = decode(Keymap, encode(Keymap, km));
  eq(back.layers.length, 2, "both layers survive");
  eq(back.layers[0].name, "base", "layer name survives");
  eq(back.layers[0].bindings[0].param1, 4, "nested repeated binding survives");
  eq(back.available_layers, 3, "scalar beside a repeated field survives");

  // The envelope, which is what actually goes on the wire.
  const req = encode(Request, { request_id: 42, keymap: { get_keymap: true } });
  eq(decode(Request, req).request_id, 42, "request id round-trips");
  eq(decode(Request, req).keymap.get_keymap, true, "subsystem request round-trips");

  // An unknown field must be skipped, not throw: a newer firmware may send
  // fields this table does not list, and losing the whole reply over one
  // unknown tag would be the worst possible failure.
  const withExtra = new Uint8Array([...encode({ a: [1, "uint32"] }, { a: 5 }),
                                    0x12, 0x02, 0x61, 0x62]);   // tag 2, string "ab"
  eq(decode({ a: [1, "uint32"] }, withExtra), { a: 5 }, "unknown fields are skipped");

  // The whole wire path, in the direction a board sends it: a response
  // envelope, framed, split across two reads, unframed and decoded. If this
  // passes, the only thing left to be wrong is the board.
  const reply = encode(Response, {
    request_response: {
      request_id: 7,
      keymap: { get_keymap: { layers: [{ id: 3, name: "nav", bindings: [{ behavior_id: -3, param1: 0x00070004 }] }] } },
    },
  });
  const wire = frame(reply);
  const rx = unframer();
  eq(rx(wire.subarray(0, 5)).length, 0, "half a reply is not a reply");
  const [payload] = rx(wire.subarray(5));
  const got = decode(Response, payload);
  eq(got.request_response.request_id, 7, "reply carries its request id back");
  const layers = got.request_response.keymap.get_keymap.layers;
  eq(layers[0].name, "nav", "layer name arrives");
  eq(layers[0].bindings[0].param1, 0x00070004, "a key usage arrives intact");

  eq(subsystemOf({ request_id: 1, keymap: {} }), "keymap", "subsystem is found");
  eq(subsystemOf({ request_id: 1 }), null, "a bare response has no subsystem");

  console.log("studio.js self-check OK");
}
