// Icons for the bindings a keycap cannot spell.
//
// "Output Selection · OUT_TOG" is four words for a thing that is one arrow,
// and at keycap size the words lose. So: a small set of shapes, as SVG path
// data on a 24x24 grid, stroked rather than filled.
//
// One table serves both views. The flat board hands the data to an SVG
// <path>; the 3D legend hands the same string to Path2D and strokes it onto
// the canvas the keycap texture is drawn from. Two renderers, one set of
// shapes, so an icon cannot mean one thing on the board and another on the
// model.

export const GLYPHS = {
  // The runic B: a stem and two chevrons.
  bluetooth: "M12 3V21M12 3L17 8L12 13M12 11L17 16L12 21",
  // A plug on a stem: the USB trident, minus the terminals nobody can see at
  // this size.
  usb: "M12 22V4M9.5 6.5L12 4L14.5 6.5M12 12.5L6.5 9M6.5 9V12M12 16.5L17.5 13M17.5 13V10",
  // Two arrows passing: swap which one is in use.
  swap: "M4 9H20M17 6L20 9L17 12M20 15H4M7 12L4 15L7 18",
  // Four ways at once, for a move with no direction to read.
  move: "M12 3V21M3 12H21M12 3L9.5 5.5M12 3L14.5 5.5M12 21L9.5 18.5M12 21L14.5 18.5"
    + "M3 12L5.5 9.5M3 12L5.5 14.5M21 12L18.5 9.5M21 12L18.5 14.5",
  // A mouse seen from above, with and without its wheel.
  mouseBody: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z",
  scroll: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z M12 6.5V11",
  clickL: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z M12 4.5V11M12 11H7.2",
  clickR: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z M12 4.5V11M12 11H16.8",
  clickM: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z M12 4.5V11.5",
  eraser: "M4.5 16.5L12.5 8.5L19 15L15.5 18.5H8Z M6 21H20",
  trash: "M4 8H20M9.5 8V5.5H14.5V8M6.5 8L7.5 20H16.5L17.5 8M10 11.5V16.5M14 11.5V16.5",
  arrowUp: "M12 20V5M6.5 11.5L12 5L17.5 11.5",
  arrowDown: "M12 4V19M6.5 12.5L12 19L17.5 12.5",
  arrowLeft: "M20 12H5M11.5 6.5L5 12L11.5 17.5",
  arrowRight: "M4 12H19M12.5 6.5L19 12L12.5 17.5",
  eject: "M6 19H18M12 4V15M8.5 11.5L12 15L15.5 11.5",
};

/**
 * Icons that are two shapes side by side.
 *
 * Clearing a profile is a bluetooth and an eraser; disconnecting one is a
 * bluetooth and a bin. Drawing those as single 24-unit paths would mean
 * authoring every shape twice, once alone and once at half scale in a corner,
 * and the two copies drifting. Composed at draw time instead — each renderer
 * already knows how to place a glyph, so it places two.
 */
export const PAIRS = {
  btClear: ["bluetooth", "eraser"],       // clear the selected profile
  btClearAll: ["bluetooth", "trash"],     // clear all of them
  btDisc: ["bluetooth", "eject"],         // drop the connection, keep the pairing
  outUsb: ["usb", "swap"],
  outBle: ["bluetooth", "swap"],
  mouseUp: ["move", "arrowUp"],
  mouseDown: ["move", "arrowDown"],
  mouseLeft: ["move", "arrowLeft"],
  mouseRight: ["move", "arrowRight"],
  scrollUp: ["scroll", "arrowUp"],
  scrollDown: ["scroll", "arrowDown"],
  scrollLeft: ["scroll", "arrowLeft"],
  scrollRight: ["scroll", "arrowRight"],
};

/** Where a pair's two halves sit on the 24-unit grid, and how small. */
export const PAIR_SCALE = 0.54;
export const PAIR_X = [0, 11];
export const PAIR_Y = 24 * (1 - PAIR_SCALE) / 2;

/** The shapes an icon draws: one, or two side by side. */
export const shapesOf = (name) => PAIRS[name] ?? (GLYPHS[name] ? [name] : null);

/**
 * Which way a mouse move or a scroll goes, decoded from its own parameter.
 *
 * ZMK packs both halves of a movement into one number: the horizontal in the
 * top sixteen bits, the vertical in the bottom, each a signed sixteen-bit
 * value. So the direction is in the binding and does not have to be guessed
 * from a name — which matters here, because all four directions are the same
 * behavior with the same display name and only the number differs.
 *
 * The two disagree about which way is up, and that is ZMK's convention rather
 * than a mistake here: a move with a negative vertical goes up the screen,
 * while a scroll with a positive vertical scrolls up.
 */
export function packedDirection(v, kind) {
  const int16 = (n) => (((n & 0xffff) << 16) >> 16);
  const hor = int16((v ?? 0) >>> 16);
  const vert = int16(v ?? 0);
  if (!hor && !vert) return "";
  if (Math.abs(hor) >= Math.abs(vert)) return hor < 0 ? "Left" : "Right";
  const up = kind === "scroll" ? vert > 0 : vert < 0;
  return up ? "Up" : "Down";
}

/**
 * A name broken into words, however it was written.
 *
 * The reason this exists: the firmware does not send ZMK's identifiers. It
 * sends what it calls things — "Clear All Profiles", "USB Output", "Toggle
 * Outputs" — and matching `BT_CLR` against those finds nothing, which is why
 * every bluetooth key drew the same plain rune. Splitting on separators and on
 * camel humps means one rule reads BT_CLR_ALL, "Clear All Profiles" and
 * "clearAllProfiles" alike.
 */
export const words = (s) => (s ?? "")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean);

const any = (w, ...list) => list.some((x) => w.includes(x));
const isBt = (w) => any(w, "bt", "ble", "bluetooth", "profile", "profiles");
const isOut = (w) => any(w, "out", "output", "outputs", "endpoint", "endpoints");
const isClear = (w) => any(w, "clr", "clear");

/**
 * What a constant's own name says it is, in the order the tests have to run.
 *
 * Order is load-bearing twice. "Clear All Profiles" has to be tried before
 * "Clear …", or clearing everything gets the eraser meant for clearing one.
 * And "BLE Output" has to be tried as an output before it is tried as a
 * bluetooth thing, or a key that switches the endpoint draws a bare rune.
 */
const CONSTANT_ICONS = [
  ["clickL", (w) => any(w, "mb1") || (any(w, "left") && any(w, "click"))],
  ["clickR", (w) => any(w, "mb2") || (any(w, "right") && any(w, "click"))],
  ["clickM", (w) => any(w, "mb3") || (any(w, "middle") && any(w, "click"))],
  ["outUsb", (w) => isOut(w) && any(w, "usb")],
  ["outBle", (w) => isOut(w) && any(w, "ble", "bluetooth")],
  ["swap", (w) => isOut(w)],
  ["btClearAll", (w) => isBt(w) && isClear(w) && any(w, "all")],
  ["btClear", (w) => isBt(w) && isClear(w)],
  ["btDisc", (w) => isBt(w) && any(w, "disc", "disconnect")],
  ["bluetooth", (w) => isBt(w)],
  ["usb", (w) => any(w, "usb")],
];

/** Which way a movement goes, from the words of its name. */
function directionOf(w) {
  if (any(w, "up")) return "Up";
  if (any(w, "down")) return "Down";
  if (any(w, "left")) return "Left";
  if (any(w, "right")) return "Right";
  return "";
}

/**
 * Which icon a binding earns, from what the firmware itself called things.
 *
 * `constant` is the name the board gave the parameter's value — BT_SEL,
 * OUT_TOG, MB1. That is data, not a guess about naming habits, which is why it
 * is asked first and why it decides.
 *
 * `behavior` is only consulted for the movement behaviors, where there is no
 * constant to read: a mouse-move macro carries a packed number, and which way
 * it moves is in its name or nowhere. Matching a name is a guess about one
 * firmware's habits — but it is a guess about a picture here rather than about
 * what a key does, so a wrong one is wrong in a way you can see and nothing
 * writes it to the board.
 */
export function iconFor(behavior, constant, mouse, param) {
  const cw = words(constant);
  const bw = words(behavior);

  // Named, and named is what a mouse button is. Testing the value instead —
  // "is it 1, 2 or 4?" — made OUT_USB a left click, OUT_BLE a right click and
  // BT_DISC a middle click, because those constants are 1, 2 and 4 too.
  if (cw.length) {
    for (const [icon, test] of CONSTANT_ICONS) if (test(cw)) return icon;
  }

  // A bare mask, with no constant to name it. Only a mouse behavior can mean
  // one — a bare 4 is the letter A everywhere else.
  if (!cw.length && mouse && any(bw, "mouse", "mkp", "mb")) {
    if (mouse === 1) return "clickL";
    if (mouse === 2) return "clickR";
    if (mouse === 4) return "clickM";
  }

  // The parameter first, the name only if the parameter said nothing: four
  // mouse-move bindings can share one display name and differ in their number.
  if (any(bw, "scrl", "scroll", "wheel", "msc")) {
    const d = packedDirection(param, "scroll") || directionOf(bw);
    return d ? `scroll${d}` : "scroll";
  }
  if (any(bw, "mmv") || (any(bw, "mouse") && any(bw, "move", "motion"))) {
    const d = packedDirection(param, "move") || directionOf(bw);
    return d ? `mouse${d}` : "move";
  }
  // The behavior's own name, for the ones whose parameter said nothing at all.
  for (const [icon, test] of CONSTANT_ICONS.slice(3)) if (test(bw)) return icon;
  return null;
}

/**
 * The text that belongs beside an icon, if any.
 *
 * A bluetooth profile is the one case where the icon is incomplete on its own:
 * five keys all drawing the same rune, and the number is the whole point. It
 * comes from the second parameter, and it is printed even when it is zero —
 * proto3 leaves a zero out of the wire, so "absent" and "profile 0" arrive
 * identically and a falsy check would blank exactly one of the five.
 *
 * Everything else with a constant loses its text: "OUT_TOG" beside two arrows
 * that already mean it is noise. Mouse buttons keep theirs, because "Click"
 * and "R Click" say which one and three near-identical mice do not.
 */
export function badgeFor(icon, constant, param2) {
  if (!icon) return null;
  const w = words(constant);
  // Selecting or dropping a profile names which one. Next and previous do not
  // have one to name, and neither does clearing.
  if ((icon === "bluetooth" && any(w, "sel", "select")) || icon === "btDisc") {
    return String(param2 ?? 0);
  }
  if (/^(bt|out)/.test(icon) || icon === "swap" || icon === "usb"
    || icon === "bluetooth") return "";
  if (icon === "move" || icon === "scroll"
    || /^(mouse|scroll)(Up|Down|Left|Right)$/.test(icon)) return "";
  return null;   // null means "keep whatever text you had"
}

/**
 * Stroke one icon onto a 2D context, scaled from its 24-unit grid.
 *
 * Path2D takes SVG path data directly, which is the whole reason the shapes
 * are stored that way — the alternative was writing every icon twice and
 * having them drift.
 */
export function drawGlyph(ctx, name, cx, cy, size, colour, weight = 2) {
  const shapes = shapesOf(name);
  if (!shapes || typeof Path2D === "undefined") return false;
  const stroke = (d, x, y, s) => {
    const k = s / 24;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.strokeStyle = colour;
    ctx.lineWidth = weight / k;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(d));
    ctx.restore();
  };
  if (shapes.length === 1) {
    stroke(GLYPHS[shapes[0]], cx - size / 2, cy - size / 2, size);
    return true;
  }
  const s = size * PAIR_SCALE;
  const unit = size / 24;
  shapes.forEach((n, i) => {
    stroke(GLYPHS[n], cx - size / 2 + PAIR_X[i] * unit, cy - size / 2 + PAIR_Y * unit, s);
  });
  return true;
}

// ------------------------------------------------------------- self-check
// node src/glyphs.js
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("glyphs.js")) {
  const eq = (got, want, what) => {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    console.assert(a === b, `${what}: got ${a}, want ${b}`);
  };

  // Every icon the resolver can name must resolve to shapes that exist, or a
  // keycap draws nothing and says nothing about why.
  const cases = [
    [null, "BT_SEL", 0], [null, "BT_NXT", 0], [null, "BT_PRV", 0],
    [null, "BT_CLR", 0], [null, "BT_CLR_ALL", 0], [null, "BT_DISC", 0],
    [null, "OUT_USB", 0], [null, "OUT_BLE", 0], [null, "OUT_TOG", 0],
    ["Mouse Key Press", "MB1", 1], ["Mouse Key Press", "MB2", 2],
    ["Mouse Key Press", "MB3", 4], ["Mouse Key Press", null, 2],
    ["mouse_move_up", null, 0], ["mouse_move_down", null, 0],
    ["mouse_move_left", null, 0], ["mouse_move_right", null, 0],
    ["mouse_scrl_up", null, 0], ["mouse_scrl_down", null, 0],
    ["mouse_move", null, 0], ["Mouse Scroll", null, 0],
    ["Bluetooth", null, 0], ["Output Selection", null, 0],
  ];
  const named = new Set();
  for (const [b, c, m] of cases) {
    const got = iconFor(b, c, m);
    console.assert(got, `no icon for ${b ?? c ?? m}`);
    if (got) named.add(got);
  }
  const broken = [...named].filter((n) => {
    const sh = shapesOf(n);
    return !sh || sh.some((s) => !GLYPHS[s]);
  });
  console.assert(broken.length === 0, `icons with missing shapes: ${broken}`);
  // Every pair must name two real shapes, including ones the resolver has no
  // route to yet — an unreachable pair is still a pair someone will reach for.
  const badPairs = Object.entries(PAIRS)
    .filter(([, sh]) => sh.length !== 2 || sh.some((s) => !GLYPHS[s]))
    .map(([n]) => n);
  console.assert(badPairs.length === 0, `pairs naming shapes that do not exist: ${badPairs}`);

  // ZMK's own identifiers.
  eq(iconFor(null, "BT_SEL", 0), "bluetooth", "a profile is a bluetooth icon");
  eq(iconFor(null, "BT_CLR", 0), "btClear", "clearing one is a bluetooth and an eraser");
  eq(iconFor(null, "BT_CLR_ALL", 0), "btClearAll", "clearing all is a bluetooth and a bin");
  eq(iconFor(null, "BT_DISC", 0), "btDisc", "and disconnecting is an eject");
  eq(iconFor(null, "OUT_USB", 0), "outUsb", "the output, and which one");
  eq(iconFor(null, "OUT_BLE", 0), "outBle", "either one");
  eq(iconFor(null, "OUT_TOG", 0), "swap", "toggling it is just the arrows");

  // And the names this board actually sends, which are not identifiers at all.
  // Reading BT_CLR against these is what found nothing.
  eq(iconFor("Bluetooth", "Clear All Profiles", 0), "btClearAll", "clear all, spelled out");
  eq(iconFor("Bluetooth", "Clear Selected Profile", 0), "btClear", "clear one, spelled out");
  eq(iconFor("Bluetooth", "Select Profile", 0), "bluetooth", "select, spelled out");
  eq(iconFor("Bluetooth", "Disconnect Profile", 0), "btDisc", "disconnect, spelled out");
  eq(iconFor("Bluetooth", "Next Profile", 0), "bluetooth", "next has no number of its own");
  eq(iconFor("Output Selection", "USB Output", 0), "outUsb", "USB output, spelled out");
  eq(iconFor("Output Selection", "BLE Output", 0), "outBle", "BLE output, spelled out");
  eq(iconFor("Output Selection", "Toggle Outputs", 0), "swap", "toggle, spelled out");
  // camelCase too, since a name is only ever however someone wrote it.
  eq(iconFor(null, "clearAllProfiles", 0), "btClearAll", "camel humps are word breaks");
  eq(words("clearAllProfiles"), ["clear", "all", "profiles"], "and that is what words does");
  eq(words("BT_CLR_ALL"), ["bt", "clr", "all"], "as are underscores");
  eq(words(null), [], "and nothing is no words");

  // "BLE Output" is both bluetooth-ish and output-ish; the output wins,
  // because that is what the key does.
  eq(iconFor(null, "BLE Output", 0), "outBle", "an output that mentions BLE is an output");

  eq(iconFor("Mouse Key Press", "MB2", 2), "clickR", "a named button");
  eq(iconFor("Mouse Key Press", null, 2), "clickR", "or a bare mask on a mouse behavior");
  eq(iconFor("Mouse Key Press", "Right Click", 2), "clickR", "or a button spelled out");
  // The three that were wrong. These constants are 1, 2 and 4, and a rule that
  // looked at the value instead of the name turned them into mouse buttons.
  eq(iconFor("Output Selection", "OUT_USB", 1), "outUsb", "OUT_USB is 1 and is not a left click");
  eq(iconFor("Output Selection", "OUT_BLE", 2), "outBle", "OUT_BLE is 2 and is not a right click");
  eq(iconFor("Bluetooth", "BT_DISC", 4), "btDisc", "BT_DISC is 4 and is not a middle click");
  eq(iconFor("Key Press", null, 4), null, "and a bare 4 on a key press is the letter A");

  // Direction, decoded from the packed parameter. This is the whole difference
  // between four mouse_move bindings, and they all share one display name.
  const packV = (v) => v & 0xffff;
  const packH = (h) => ((h & 0xffff) << 16) >>> 0;
  eq(packedDirection(packV(-600), "move"), "Up", "a move up is a negative vertical");
  eq(packedDirection(packV(600), "move"), "Down", "and down is positive");
  eq(packedDirection(packH(-600), "move"), "Left", "left is a negative horizontal");
  eq(packedDirection(packH(600), "move"), "Right", "and right positive");
  // ZMK's own convention, and the two really do disagree.
  eq(packedDirection(packV(10), "scroll"), "Up", "a scroll up is a POSITIVE vertical");
  eq(packedDirection(packV(-10), "scroll"), "Down", "and down negative");
  eq(packedDirection(0, "move"), "", "a zero move goes nowhere");
  eq(iconFor("mouse_move", null, 0, packV(-600)), "mouseUp", "up");
  eq(iconFor("mouse_move", null, 0, packV(600)), "mouseDown", "down");
  eq(iconFor("mouse_move", null, 0, packH(-600)), "mouseLeft", "left");
  eq(iconFor("mouse_move", null, 0, packH(600)), "mouseRight", "right");
  eq(iconFor("mouse_scrl", null, 0, packV(10)), "scrollUp", "and a wheel has one too");
  eq(iconFor("mouse_move", null, 0, 0), "move", "with no direction to read, all four");
  // The name is still read when there is no parameter to decode. A macro named
  // for its direction is how these arrive when they are macros.
  eq(iconFor("mouse_move_up", null, 0), "mouseUp", "a name can still say it");
  eq(iconFor("Mouse Move Left", null, 0), "mouseLeft", "however it is written");
  eq(iconFor("mouseMoveRight", null, 0), "mouseRight", "including camelCase");
  // "mouse_move_update" is not upward. The word has to stand alone, which is
  // what splitting into words gets that a substring search does not.
  eq(iconFor("mouse_move_update", null, 0), "move", "a word containing 'up' is not up");

  eq(iconFor("Key Press", null, 0), null, "an ordinary key has no icon");
  eq(iconFor(undefined, undefined, undefined), null, "nor undefined");
  eq(iconFor("Mouse Key Press", null, 8), null, "a mask with no icon draws none");
  eq(iconFor(null, null, 2), null, "and a mask with no behavior to place it draws none");

  // The badge beside an icon.
  eq(badgeFor("bluetooth", "BT_SEL", 0), "0", "profile zero still prints its number");
  eq(badgeFor("bluetooth", "Select Profile", 3), "3", "and profile three, spelled out");
  eq(badgeFor("bluetooth", "Next Profile", 0), "", "next has no number to print");
  eq(badgeFor("btClear", "Clear Selected Profile", 0), "", "clearing needs no number");
  eq(badgeFor("btClearAll", "Clear All Profiles", 0), "", "nor does clearing all");
  eq(badgeFor("btDisc", "BT_DISC", 2), "2", "disconnecting names the profile it drops");
  eq(badgeFor("outUsb", "USB Output", 0), "", "nor does the output");
  eq(badgeFor("swap", "Toggle Outputs", 0), "", "nor toggling it");
  eq(badgeFor("mouseUp", null, 0), "", "nor a direction");
  eq(badgeFor("clickR", "MB2", 0), null, "a mouse button keeps its words");
  eq(badgeFor(null, "BT_SEL", 2), null, "no icon, no badge");

  // Path data has to be parseable as path data, which here means starting on a
  // move and using only the commands Path2D and <path> both take.
  const bad = Object.entries(GLYPHS)
    .filter(([, d]) => !/^M/.test(d) || /[^MLHVAZmlhvaz0-9.\s-]/.test(d))
    .map(([n]) => n);
  console.assert(bad.length === 0, `icons with unusable path data: ${bad}`);

  console.log(`glyphs.js self-check OK (${Object.keys(GLYPHS).length} shapes, ${Object.keys(PAIRS).length} pairs)`);
}
