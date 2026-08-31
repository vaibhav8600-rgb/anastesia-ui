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

// Mouse buttons are the Button page, where the id is simply the button number.
const BUTTON_GROUPS = {
  Mouse: {
    1: "Left Click", 2: "Right Click", 3: "Middle Click",
    4: "Mouse Back", 5: "Mouse Forward",
    6: "Mouse 6", 7: "Mouse 7", 8: "Mouse 8",
  },
};

const flatten = (groups) => Object.assign({}, ...Object.values(groups));
const KEYBOARD = flatten(KEYBOARD_GROUPS);
const CONSUMER = flatten(CONSUMER_GROUPS);
const BUTTON = flatten(BUTTON_GROUPS);

/** A usage as ZMK packs it, back into something readable. */
export function usageName(param) {
  if (!param) return null;
  const page = (param >>> 16) & 0xffff;
  const id = param & 0xffff;
  if (page === PAGE_KEY) return KEYBOARD[id] ?? `0x${id.toString(16)}`;
  if (page === PAGE_CONSUMER) return CONSUMER[id] ?? `0x${id.toString(16)}`;
  if (page === PAGE_BUTTON) return BUTTON[id] ?? `Mouse ${id}`;
  // A bare id with no page is how some keymaps are written; assume keyboard.
  if (page === 0) return KEYBOARD[id] ?? `0x${id.toString(16)}`;
  return `${page.toString(16)}:${id.toString(16)}`;
}

/** The short form, for drawing on a key that is 40px wide. */
export function usageShort(param) {
  const full = usageName(param);
  if (!full) return null;
  // "- minus" and "→ Right" carry the glyph first precisely so this can cut
  // at the space and keep the half that reads at a glance.
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
  ...Object.entries(BUTTON_GROUPS).map(([group, ids]) => ({
    group,
    items: Object.entries(ids).map(([id, name]) => ({ name, param: (PAGE_BUTTON << 16) | Number(id) })),
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
  eq(usageName((PAGE_BUTTON << 16) | 1), "Left Click", "mouse left");
  eq(usageName((PAGE_BUTTON << 16) | 2), "Right Click", "mouse right");
  eq(usageName((PAGE_BUTTON << 16) | 9), "Mouse 9", "an unlisted button still names itself");
  eq(usageName(0x04), "A", "a bare id is read as keyboard");
  eq(usageName((PAGE_KEY << 16) | 0xfe), "0xfe", "an unknown usage shows its number");
  eq(usageName(0), null, "no binding parameter");

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

  console.log(`keycodes.js self-check OK (${ALL_CHOICES.length} usages in ${CHOICE_GROUPS.length} groups)`);
}
