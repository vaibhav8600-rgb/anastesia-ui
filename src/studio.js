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

/**
 * The keys too small to carry a label, as a set of positions.
 *
 * Measured against the other keys on this board, not against the board's
 * width. A fraction-of-span rule works on a trackball — eight keys and four
 * encoder slivers — and falls apart on a keyboard, where a sixty-key split
 * board sits within a rounding error of the threshold and could drop every
 * one of its keys into the "too small to draw" list the board had just drawn.
 *
 * A sliver is a sliver relative to its neighbours. Median rather than mean, so
 * a handful of slivers cannot drag the comparison down to meet themselves.
 */
export function tinyKeys(keys) {
  if (!keys?.length) return new Set();
  const area = (k) => (k.width ?? 100) * (k.height ?? 100);
  const sorted = keys.map(area).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!median) return new Set();
  const out = new Set();
  keys.forEach((k, i) => { if (area(k) / median < 0.35) out.add(i); });
  return out;
}

/** A third of a key unit. Well past rounding, well under any real split. */
const SEAM_MM = 19.05 / 3;

/**
 * Which keys belong to which half, from the one vertical line no key crosses.
 *
 * Measured edge to edge, not centre to centre. Centres were the first attempt
 * and they do not work: a Sofle's thumb clusters reach inboard past its inner
 * column, so the widest gap between centres is inside a half rather than
 * between them, and the board came out as one piece with a notch in it.
 *
 * Keys within a half abut, so any real emptiness spanning the board is the
 * seam. A third of a key unit is well past rounding and well under the
 * narrowest gap anyone leaves.
 */
export function splitHalves(spots) {
  if (spots.length < 4) return [spots.map((_, i) => i)];
  const order = spots
    .map((s, i) => ({ i, l: s.x - s.w / 2, r: s.x + s.w / 2 }))
    .sort((a, b) => a.l - b.l);
  let reach = order[0].r, best = 0, at = -1;
  for (let n = 1; n < order.length; n++) {
    const gap = order[n].l - reach;
    if (gap > best) { best = gap; at = n; }
    reach = Math.max(reach, order[n].r);
  }
  if (best < SEAM_MM || at < 0) return [spots.map((_, i) => i)];
  return [order.slice(0, at).map((o) => o.i), order.slice(at).map((o) => o.i)];
}

/**
 * The key positions that are encoders rather than keycaps.
 *
 * An encoder's push is a switch, so the board reports it as a key position
 * like any other — a 58-key Sofle arrives as 60. The reference model has no
 * such position at all: it draws 58 keycaps and then places two knobs from
 * measured constants. Its measurements are the useful part, so they are what
 * finds the switch here.
 *
 * The first attempt looked for isolation, on the theory that an encoder sits
 * on its own. On a real board it does not sit far enough on its own — it has a
 * keycap within a key unit of it — and no encoder was found at all. So this
 * asks where the reference says the knob is instead: inboard of every column
 * of the key block, about 48mm behind the top row.
 *
 * Both halves of that matter. Inboard of the block rules out the block itself,
 * and the depth rules out the rotated thumb key, which is also inboard and
 * also alone in its column but sits 40mm further down. A board with nothing at
 * that spot gets no knob, which is the right answer for a board with no
 * encoder.
 */
const COL_MIN = 3;            // keys sharing an x before it counts as a column
const ENCODER_Z = 48;         // the reference's own measurement, millimetres
const ENCODER_Z_SLOP = 26;    // nearer the thumb row than this and it is a key

export function encoderKeys(spots, halves) {
  const out = new Set();
  // One knob per half, and the halves are what say which way "inboard" is.
  if (!halves || halves.length !== 2) return out;
  halves.forEach((idx, side) => {
    if (idx.length < 8) return;
    const sign = side === 0 ? 1 : -1;
    const cols = new Map();
    for (const p of idx) {
      const k = Math.round(spots[p].x / (19.05 / 4));
      if (!cols.has(k)) cols.set(k, []);
      cols.get(k).push(p);
    }
    let edge = -Infinity;
    for (const members of cols.values()) {
      if (members.length < COL_MIN) continue;
      const x = spots[members[0]].x * sign;
      if (x > edge) edge = x;
    }
    if (edge === -Infinity) return;

    const zTop = Math.min(...idx.map((p) => spots[p].z));
    let best = null, bestD = Infinity;
    for (const members of cols.values()) {
      if (members.length !== 1) continue;
      const p = members[0];
      if (spots[p].x * sign <= edge) continue;
      const d = Math.abs(spots[p].z - (zTop + ENCODER_Z));
      if (d <= ENCODER_Z_SLOP && d < bestD) { bestD = d; best = p; }
    }
    if (best !== null) out.add(best);
  });
  return out;
}

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

  // The layer requests, which restructure a keymap rather than edit one key.
  const layerReq = (body) => decode(Request, encode(Request, { request_id: 1, keymap: body }));
  eq(layerReq({ add_layer: {} }).keymap.add_layer, {}, "add_layer is an empty message, not a bool");
  eq(layerReq({ remove_layer: { layer_index: 3 } }).keymap.remove_layer.layer_index, 3, "remove names an index");
  // Zero is written rather than omitted. proto3 would normally leave a default
  // out, but an explicit 0 is valid on the wire, decodes to 0, and removes any
  // question about which member of the oneof was meant — which matters most
  // for layer 0, the one people remove by accident.
  eq(layerReq({ remove_layer: { layer_index: 0 } }).keymap.remove_layer.layer_index, 0, "removing layer 0 says so explicitly");
  const props = layerReq({ set_layer_props: { layer_id: 2, name: "Nav" } }).keymap.set_layer_props;
  eq(props.layer_id, 2, "rename carries the layer id");
  eq(props.name, "Nav", "and the new name");
  eq(layerReq({ set_layer_props: { layer_id: 1, name: "Ünïcøde" } }).keymap.set_layer_props.name,
     "Ünïcøde", "a name outside ASCII survives the wire");

  // Which keys are too small to label.
  const grid = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 12; c++) grid.push({ x: c * 100, y: r * 100, width: 100, height: 100 });
  eq(tinyKeys(grid).size, 0, "a uniform keyboard has no unlabellable keys");
  const trackball = [
    ...Array.from({ length: 8 }, (_, i) => ({ x: i * 100, y: 0, width: 100, height: 100 })),
    ...Array.from({ length: 4 }, (_, i) => ({ x: i * 40, y: 200, width: 40, height: 40 })),
  ];
  eq([...tinyKeys(trackball)], [8, 9, 10, 11], "encoder slivers are, and only they are");
  eq(tinyKeys([]).size, 0, "no keys, no slivers");
  // A board of nothing but slivers is a board of ordinary keys.
  eq(tinyKeys(trackball.slice(8)).size, 0, "smallness is relative, so all-small is all-normal");

  // Where a split board comes apart. Positions here are millimetres, the
  // shape the 3D view works in.
  const row = (x0, n) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * 19.05, w: 19.05 }));
  eq(splitHalves(row(0, 12)).length, 1, "a board with no gap is one board");
  const apart = [...row(0, 6), ...row(6 * 19.05 + 40, 6)];
  eq(splitHalves(apart).map((h) => h.length), [6, 6], "a real gap comes apart in the middle");
  // The shape that broke the first attempt. A Sofle's thumb cluster reaches
  // inboard past its own inner column, so the seam it leaves is about one key
  // unit — and the first rule measured centre to centre and wanted two and a
  // half before it would believe in a split. It found none, and the board was
  // drawn as one piece with a notch in it. Edge to edge, a thumb key that
  // overlaps the column above it opens no gap at all, and the only emptiness
  // spanning the board is the seam.
  // Written out in key units rather than generated, because the first version
  // of this fixture put the thumbs outboard by arithmetic slip and passed a
  // board with no seam in it at all.
  const at = (n) => ({ x: n * 19.05, w: 19.05 });
  //                columns    thumbs, the last reaching inboard past column 5
  const lhs = [0, 1, 2, 3, 4, 5, 2, 3, 4, 5, 6].map(at);
  const rhs = [8, 9, 10, 11, 12, 13, 8, 9, 10, 11, 12].map(at);
  eq(splitHalves([...lhs, ...rhs]).map((h) => h.length), [11, 11],
     "thumb keys reaching inboard do not open a seam of their own");
  eq(splitHalves([]).length, 1, "no keys, one board");
  eq(splitHalves(row(0, 2)).length, 1, "too few keys to have a seam");

  // Which reported positions are knobs rather than keycaps. A half here is a
  // 6x4 block, a four-key thumb row, one rotated thumb inboard at the bottom,
  // and — where the board has one — an encoder inboard at mid-depth.
  const U2 = 19.05;
  const halfAt = (x0, sign, withKnob) => {
    const out = [];
    for (let c = 0; c < 6; c++) for (let r = 0; r < 4; r++) {
      out.push({ x: x0 + sign * c * U2, z: r * U2, w: U2 });
    }
    for (let c = 2; c < 6; c++) out.push({ x: x0 + sign * c * U2, z: 4.2 * U2, w: U2 });
    // The rotated thumb: inboard, alone in its column, and low down.
    out.push({ x: x0 + sign * 6.3 * U2, z: 88, w: U2 });
    if (withKnob) out.push({ x: x0 + sign * 6.1 * U2, z: 48, w: U2 });
    return out;
  };
  const build = (withKnob) => {
    const l = halfAt(0, 1, withKnob);
    const r = halfAt(14 * U2, -1, withKnob);
    const all = [...l, ...r];
    return { all, halves: [l.map((_, i) => i), r.map((_, i) => i + l.length)] };
  };
  const withEnc = build(true);
  eq(encoderKeys(withEnc.all, withEnc.halves).size, 2, "one knob per half, where there is one");
  const noEnc = build(false);
  eq(encoderKeys(noEnc.all, noEnc.halves).size, 0, "and none where there is not");
  // The rotated thumb is the trap: inboard and alone, but far too low.
  const thumbs = noEnc.halves.flat().filter((i) => noEnc.all[i].z === 88);
  eq(thumbs.length, 2, "the fixture does have two rotated thumbs to reject");
  // Isolation, which this replaced, would have missed the real thing: the
  // encoder here has a keycap one unit away from it.
  const enc = [...encoderKeys(withEnc.all, withEnc.halves)];
  const near = enc.map((p) => Math.min(...withEnc.all
    .map((s, j) => (j === p ? Infinity : Math.hypot(s.x - withEnc.all[p].x, s.z - withEnc.all[p].z)))));
  console.assert(near.every((d) => d < U2 * 1.25),
    `the fixture's encoders are meant to have close neighbours: ${near}`);
  eq(encoderKeys(withEnc.all, null).size, 0, "no halves, no knobs");

  eq(subsystemOf({ request_id: 1, keymap: {} }), "keymap", "subsystem is found");
  eq(subsystemOf({ request_id: 1 }), null, "a bare response has no subsystem");

  console.log("studio.js self-check OK");
}
