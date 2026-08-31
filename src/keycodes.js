// HID usages, so a binding reads as a key rather than as 0x00070004.
//
// ZMK packs a usage as (page << 16) | id. Three pages matter for a keymap:
// 0x07 keyboard, 0x0C consumer (media, brightness, launchers) and 0x09 button
// (mouse). Everything is grouped, because a flat list of three hundred usages
// is not something anyone can find "volume up" in.

export const PAGE_KEY = 0x07;
export const PAGE_CONSUMER = 0x0c;
export const PAGE_BUTTON = 0x09;

/** [id, name] pairs per group, so one table serves both naming and the picker. */
const KEYBOARD_GROUPS = {
  Letters: Object.fromEntries(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c, i) => [0x04 + i, c]),
  ),
  Numbers: {
    0x1e: "1", 0x1f: "2", 0x20: "3", 0x21: "4", 0x22: "5",
    0x23: "6", 0x24: "7", 0x25: "8", 0x26: "9", 0x27: "0",
  },
  Editing: {
    0x28: "Enter", 0x29: "Esc", 0x2a: "Backspace", 0x2b: "Tab", 0x2c: "Space",
    0x49: "Insert", 0x4c: "Delete",
  },
  Punctuation: {
    0x2d: "- minus", 0x2e: "= equals", 0x2f: "[ bracket", 0x30: "] bracket",
    0x31: "\\ backslash", 0x32: "# non-US hash", 0x33: "; semicolon",
    0x34: "' quote", 0x35: "` grave", 0x36: ", comma", 0x37: ". period",
    0x38: "/ slash", 0x64: "\\ non-US backslash",
  },
  Navigation: {
    0x4a: "Home", 0x4b: "Page Up", 0x4d: "End", 0x4e: "Page Down",
    0x4f: "→ Right", 0x50: "← Left", 0x51: "↓ Down", 0x52: "↑ Up",
  },
  Function: Object.fromEntries([
    ...Array.from({ length: 12 }, (_, i) => [0x3a + i, `F${i + 1}`]),
    ...Array.from({ length: 12 }, (_, i) => [0x68 + i, `F${i + 13}`]),
  ]),
  Modifiers: {
    0xe0: "Left Ctrl", 0xe1: "Left Shift", 0xe2: "Left Alt", 0xe3: "Left GUI",
    0xe4: "Right Ctrl", 0xe5: "Right Shift", 0xe6: "Right Alt", 0xe7: "Right GUI",
  },
  Keypad: {
    0x53: "Num Lock", 0x54: "Keypad /", 0x55: "Keypad *", 0x56: "Keypad -",
    0x57: "Keypad +", 0x58: "Keypad Enter", 0x59: "Keypad 1", 0x5a: "Keypad 2",
    0x5b: "Keypad 3", 0x5c: "Keypad 4", 0x5d: "Keypad 5", 0x5e: "Keypad 6",
    0x5f: "Keypad 7", 0x60: "Keypad 8", 0x61: "Keypad 9", 0x62: "Keypad 0",
    0x63: "Keypad .", 0x67: "Keypad =",
  },
  System: {
    0x39: "Caps Lock", 0x46: "Print Screen", 0x47: "Scroll Lock", 0x48: "Pause",
    0x65: "Application / Menu", 0x66: "Power",
    0x75: "Help", 0x77: "Select", 0x79: "Again", 0x7a: "Undo",
    0x7b: "Cut", 0x7c: "Copy", 0x7d: "Paste", 0x7e: "Find",
  },
  International: {
    0x87: "International 1", 0x88: "International 2", 0x89: "International 3",
    0x8a: "International 4", 0x8b: "International 5",
    0x90: "Lang 1 / Hangul", 0x91: "Lang 2 / Hanja", 0x92: "Lang 3 / Katakana",
    0x93: "Lang 4 / Hiragana",
  },
};

const CONSUMER_GROUPS = {
  Volume: {
    0x00e2: "Mute", 0x00e9: "Volume Up", 0x00ea: "Volume Down",
  },
  Media: {
    0x00b0: "Play", 0x00b1: "Pause", 0x00b3: "Fast Forward", 0x00b4: "Rewind",
    0x00b5: "Next Track", 0x00b6: "Previous Track", 0x00b7: "Stop",
    0x00b8: "Eject", 0x00cd: "Play / Pause",
  },
  Display: {
    0x006f: "Brightness Up", 0x0070: "Brightness Down",
  },
  Browser: {
    0x0223: "Browser Home", 0x0224: "Browser Back", 0x0225: "Browser Forward",
    0x0226: "Browser Stop", 0x0227: "Browser Refresh",
    0x022a: "Bookmarks", 0x0221: "Search",
  },
  Launch: {
    0x0183: "Media Player", 0x018a: "Email", 0x0192: "Calculator",
    0x0194: "File Explorer", 0x01a2: "Task Manager", 0x019c: "Log Off",
    0x0201: "New", 0x0203: "Close", 0x0207: "Save", 0x0208: "Print",
  },
  Power: {
    0x0030: "Power", 0x0032: "Sleep", 0x0034: "Sleep Mode", 0x0036: "Standby",
  },
};

// Mouse buttons are NOT a HID usage here. ZMK's dt-bindings/zmk/mouse.h makes
// them bitmasks — MB1 is 1, MB2 is 2, MB3 is 4 — so a mouse binding carries a
// bare mask with no page byte at all. This board's own keys prove it: they hold
// 1 and 2, which is left and right click.
//
// That collides with the keyboard page, where a bare 4 is the letter A, and
// nothing in the number itself can separate them. The behavior decides, so
// usageName takes a hint rather than guessing.
export const MOUSE_BUTTONS = {
  1: "Left Click", 2: "Right Click", 4: "Middle Click",
  8: "Mouse Back", 16: "Mouse Forward",
};

export const MOUSE_CHOICES = Object.entries(MOUSE_BUTTONS)
  .map(([mask, name]) => ({ name, param: Number(mask) }));

const flatten = (groups) => Object.assign({}, ...Object.values(groups));
const KEYBOARD = flatten(KEYBOARD_GROUPS);
const CONSUMER = flatten(CONSUMER_GROUPS);

// ZMK packs implicit modifiers into the top byte, so a usage is really
// (mods << 24) | (page << 16) | id. Ctrl+C is 0x01070006 and Ctrl+Shift+Tab is
// 0x0307002B. Reading the page as sixteen bits swallows the modifier byte and
// turns those into "107:6" and "307:2b", which is what they were showing.
const MODS = [
  [0x01, "Ctrl"], [0x02, "Shift"], [0x04, "Alt"], [0x08, "GUI"],
  [0x10, "RCtrl"], [0x20, "RShift"], [0x40, "RAlt"], [0x80, "RGUI"],
];

export function modNames(mods) {
  return MODS.filter(([bit]) => mods & bit).map(([, name]) => name);
}

/**
 * A usage as ZMK packs it, back into something readable.
 *
 * `kind` is the behavior's namespace: "mouse" reads the value as a button
 * mask, anything else as a HID usage. Without it a bare 4 is both the letter A
 * and the middle mouse button.
 */
export function usageName(param, kind) {
  if (!param) return null;
  if (kind === "mouse") {
    if (MOUSE_BUTTONS[param]) return MOUSE_BUTTONS[param];
    // A mask can set more than one button. Name each bit rather than borrowing
    // the modifier names, which have nothing to do with mouse buttons.
    const set = [];
    for (let bit = 1; bit <= 0x80; bit <<= 1) {
      if (param & bit) set.push(MOUSE_BUTTONS[bit] ?? `Button ${Math.log2(bit) + 1}`);
    }
    return set.length ? set.join(" + ") : `mask 0x${param.toString(16)}`;
  }
  const mods = (param >>> 24) & 0xff;
  const page = (param >>> 16) & 0xff;
  const id = param & 0xffff;
  const base = baseName(page, id);
  return mods ? [...modNames(mods), base].join("+") : base;
}

function baseName(page, id) {
  if (page === PAGE_KEY) return KEYBOARD[id] ?? `0x${id.toString(16)}`;
  if (page === PAGE_CONSUMER) return CONSUMER[id] ?? `0x${id.toString(16)}`;
  // Kept in case a firmware does page-encode its buttons, even though this one
  // does not.
  if (page === PAGE_BUTTON) return MOUSE_BUTTONS[1 << (id - 1)] ?? `Mouse ${id}`;
  // A bare id with no page is how a plain keyboard usage is often written.
  if (page === 0) return KEYBOARD[id] ?? `0x${id.toString(16)}`;
  return `page ${page.toString(16)}:${id.toString(16)}`;
}

/** The short form, for drawing on a key that is 40px wide. */
export function usageShort(param, kind) {
  const full = usageName(param, kind);
  if (!full) return null;
  // "- minus" and "→ Right" carry the glyph first precisely so this can cut
  // at the space and keep the half that reads at a glance.
  // A modified key keeps its whole name — "Ctrl+C" is the point of it, and
  // cutting at the space would leave "Ctrl+C" as "Ctrl+C" anyway since the
  // join uses +, but a plain "- minus" still wants its glyph alone.
  if (full.includes("+")) return full;
  const cut = full.split(" ")[0];
  return cut.length <= 3 || /^[A-Z0-9]$/.test(cut) ? cut : full.replace(/^(Keypad|Browser|Mouse) /, "");
}

/**
 * Everything bindable, grouped for a picker. Built from the same tables that
 * name a binding, so the list and the label can never disagree.
 */
export const CHOICE_GROUPS = [
  ...Object.entries(KEYBOARD_GROUPS).map(([group, ids]) => ({
    group,
    items: Object.entries(ids).map(([id, name]) => ({ name, param: (PAGE_KEY << 16) | Number(id) })),
  })),
  ...Object.entries(CONSUMER_GROUPS).map(([group, ids]) => ({
    group,
    items: Object.entries(ids).map(([id, name]) => ({ name, param: (PAGE_CONSUMER << 16) | Number(id) })),
  })),
];

export const ALL_CHOICES = CHOICE_GROUPS.flatMap((g) => g.items);

// node src/keycodes.js
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("keycodes.js")) {
  const eq = (a, b, m) => console.assert(a === b, `${m}: got ${JSON.stringify(a)}`);
  eq(usageName((PAGE_KEY << 16) | 0x04), "A", "keyboard A");
  eq(usageName((PAGE_KEY << 16) | 0x28), "Enter", "keyboard Enter");
  eq(usageName((PAGE_KEY << 16) | 0x45), "F12", "F12 from the generated run");
  eq(usageName((PAGE_KEY << 16) | 0x73), "F24", "F24 from the second run");
  eq(usageName((PAGE_CONSUMER << 16) | 0x00e9), "Volume Up", "volume up is findable");
  eq(usageName((PAGE_CONSUMER << 16) | 0x00ea), "Volume Down", "volume down is findable");
  eq(usageName((PAGE_BUTTON << 16) | 1), "Left Click", "a page-encoded button still reads");
  eq(usageName((PAGE_KEY << 16) | 0xfe), "0xfe", "an unknown usage shows its number");
  eq(usageName(0), null, "no binding parameter");

  // Implicit modifiers, which is what "307:2b" on a key cap turned out to be.
  eq(usageName(0x01070006), "Ctrl+C", "copy on Windows and Linux");
  eq(usageName(0x0107001b), "Ctrl+X", "cut");
  eq(usageName(0x0307002b), "Ctrl+Shift+Tab", "two modifiers, in bit order");
  eq(usageName(0x08070006), "GUI+C", "the GUI modifier");
  eq(usageName(0x00070006), "C", "no modifier byte is still a plain key");
  eq(usageShort(0x01070006), "Ctrl+C", "a modified key keeps its whole name");
  // The namespace collision, and why the hint exists.
  eq(usageName(1, "mouse"), "Left Click", "a mouse behavior reads 1 as a button");
  eq(usageName(2, "mouse"), "Right Click", "and 2 as the right one");
  eq(usageName(4, "mouse"), "Middle Click", "MB3 is the bit, not the index");
  eq(usageName(0x04), "A", "the same 4 without the hint is the letter A");
  eq(usageName(3, "mouse"), "Left Click + Right Click", "a multi-button mask names each bit");
  eq(usageName(32, "mouse"), "Button 6", "a bit with no name still says which button");
  eq(usageShort(2, "mouse"), "Right Click", "the short form takes the hint too");

  eq(usageShort((PAGE_KEY << 16) | 0x2d), "-", "punctuation cuts to its glyph");
  eq(usageShort((PAGE_KEY << 16) | 0x4f), "→", "an arrow cuts to its arrow");
  eq(usageShort((PAGE_KEY << 16) | 0x59), "1", "a keypad key drops its prefix");
  eq(usageShort((PAGE_CONSUMER << 16) | 0x00e9), "Volume Up", "a long name stays whole");

  // Every choice must name itself the same way a binding does, or the picker
  // and the key cap disagree about what a key is.
  const wrong = ALL_CHOICES.filter((c) => usageName(c.param) !== c.name);
  console.assert(wrong.length === 0, `choices that do not round-trip: ${JSON.stringify(wrong.slice(0, 3))}`);

  const ids = ALL_CHOICES.map((c) => c.param);
  console.assert(new Set(ids).size === ids.length, "a usage is listed twice");

  const mouseWrong = MOUSE_CHOICES.filter((c) => usageName(c.param, "mouse") !== c.name);
  console.assert(mouseWrong.length === 0, `mouse choices that do not round-trip: ${JSON.stringify(mouseWrong)}`);

  console.log(`keycodes.js self-check OK (${ALL_CHOICES.length} usages in ${CHOICE_GROUPS.length} groups, ${MOUSE_CHOICES.length} mouse buttons)`);
}
