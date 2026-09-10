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
  // Bluetooth with the stem struck through — a profile being cleared.
  btClear: "M12 3V21M12 3L17 8L12 13M12 11L17 16L12 21M4 4L20 20",
  // A plug on a stem: the USB trident, minus the terminals nobody can see at
  // this size.
  usb: "M12 22V4M9.5 6.5L12 4L14.5 6.5M12 12.5L6.5 9M6.5 9V12M12 16.5L17.5 13M17.5 13V10",
  // Two arrows passing: swap which one is in use.
  swap: "M4 9H20M17 6L20 9L17 12M20 15H4M7 12L4 15L7 18",
  // Four ways at once.
  move: "M12 3V21M3 12H21M12 3L9.5 5.5M12 3L14.5 5.5M12 21L9.5 18.5M12 21L14.5 18.5"
    + "M3 12L5.5 9.5M3 12L5.5 14.5M21 12L18.5 9.5M21 12L18.5 14.5",
  // A mouse seen from above, with its wheel.
  scroll: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z M12 6.5V11",
  clickL: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z M12 4.5V11M12 11H7.2",
  clickR: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z M12 4.5V11M12 11H16.8",
  clickM: "M7 9A5 5 0 0 1 17 9V16A5 5 0 0 1 7 16Z M12 4.5V11.5",
  // Sent away rather than switched.
  eject: "M6 19H18M12 4V15M8.5 11.5L12 15L15.5 11.5",
};

/**
 * Which icon a binding earns, from what the firmware itself called things.
 *
 * `constant` is the name the board gave the parameter's value — BT_SEL,
 * OUT_TOG, MB1. That is data, not a guess about naming habits, which is why it
 * is asked first and why it decides.
 *
 * `behavior` is only consulted for the movement behaviors, where there is no
 * constant to read: a mouse-move macro carries a packed number. Matching a
 * name is a guess about one firmware's habits, and it is a guess about a
 * picture here rather than about what a key does — a wrong icon is wrong in a
 * way you can see and nothing writes it to the board.
 */
export function iconFor(behavior, constant, mouse) {
  if (mouse) {
    if (mouse === 1) return "clickL";
    if (mouse === 2) return "clickR";
    if (mouse === 4) return "clickM";
  }
  const c = (constant ?? "").toUpperCase();
  if (c.startsWith("BT_CLR") || c.startsWith("BT_DISC")) return "btClear";
  if (c.startsWith("BT_")) return "bluetooth";
  if (c === "OUT_USB") return "usb";
  if (c === "OUT_BLE") return "bluetooth";
  if (c === "OUT_TOG") return "swap";

  const b = (behavior ?? "").toLowerCase();
  if (/scrl|scroll|wheel/.test(b)) return "scroll";
  if (/mouse.*mo(ve|tion)|mo(ve|tion).*mouse|mmv/.test(b)) return "move";
  if (/bluetooth/.test(b)) return "bluetooth";
  if (/output/.test(b)) return "swap";
  return null;
}

/**
 * Stroke one icon onto a 2D context, scaled from its 24-unit grid.
 *
 * Path2D takes SVG path data directly, which is the whole reason the shapes
 * are stored that way — the alternative was writing every icon twice and
 * having them drift.
 */
export function drawGlyph(ctx, name, cx, cy, size, colour, weight = 2) {
  const d = GLYPHS[name];
  if (!d || typeof Path2D === "undefined") return false;
  const k = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(k, k);
  ctx.strokeStyle = colour;
  ctx.lineWidth = weight / k;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(new Path2D(d));
  ctx.restore();
  return true;
}

// ------------------------------------------------------------- self-check
// node src/glyphs.js
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("glyphs.js")) {
  const eq = (got, want, what) => {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    console.assert(a === b, `${what}: got ${a}, want ${b}`);
  };

  // Every icon the resolver can name has to exist, or a keycap draws nothing
  // and says nothing about why.
  const named = new Set();
  for (const [behavior, constant, mouse] of [
    [null, "BT_SEL", 0], [null, "BT_NXT", 0], [null, "BT_CLR", 0], [null, "BT_DISC", 0],
    [null, "OUT_USB", 0], [null, "OUT_BLE", 0], [null, "OUT_TOG", 0],
    [null, null, 1], [null, null, 2], [null, null, 4],
    ["mouse_move_up", null, 0], ["mouse_scrl_down", null, 0],
    ["Bluetooth", null, 0], ["Output Selection", null, 0],
  ]) {
    const got = iconFor(behavior, constant, mouse);
    console.assert(got, `no icon for ${behavior ?? constant ?? mouse}`);
    if (got) named.add(got);
  }
  const missing = [...named].filter((n) => !GLYPHS[n]);
  console.assert(missing.length === 0, `resolver names icons with no path: ${missing}`);

  eq(iconFor(null, "BT_SEL", 0), "bluetooth", "a profile is a bluetooth icon");
  eq(iconFor(null, "BT_CLR", 0), "btClear", "clearing one is struck through");
  eq(iconFor(null, "OUT_TOG", 0), "swap", "toggling the output is two arrows");
  eq(iconFor(null, null, 2), "clickR", "the right button mask");
  // The constant decides, not the behavior. A mouse behavior holding MB2 is a
  // right click, and a bluetooth behavior holding a profile is a profile.
  eq(iconFor("Mouse Key Press", "MB2", 2), "clickR", "the mask wins over the name");
  eq(iconFor("Bluetooth", "BT_SEL", 0), "bluetooth", "and the constant over the name");
  eq(iconFor("Key Press", null, 0), null, "an ordinary key has no icon");
  eq(iconFor(null, null, 0), null, "and neither has nothing at all");
  eq(iconFor(undefined, undefined, undefined), null, "nor undefined");
  // A stray mask is not a button. MB4/MB5 exist and have no icon drawn yet;
  // they must fall through rather than pick the wrong one.
  eq(iconFor(null, null, 8), null, "a mask with no icon draws none");

  // Path data has to be parseable as path data, which here means starting on a
  // move and using only the commands Path2D and <path> both take.
  const bad = Object.entries(GLYPHS)
    .filter(([, d]) => !/^M/.test(d) || /[^MLHVAZmlhvaz0-9.\s-]/.test(d))
    .map(([n]) => n);
  console.assert(bad.length === 0, `icons with unusable path data: ${bad}`);

  console.log(`glyphs.js self-check OK (${Object.keys(GLYPHS).length} icons)`);
}
