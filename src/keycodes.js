// HID usages, so a binding reads as a key rather than as 0x00070004.
//
// ZMK packs a usage as (page << 16) | id. Page 0x07 is the keyboard page and
// carries nearly everything; 0x0C is the consumer page, where media keys live.
// Only the usages a keymap actually uses are listed — the full HID tables run
// to thousands of entries, most of which no keyboard can send.

export const PAGE_KEY = 0x07;
export const PAGE_CONSUMER = 0x0c;

const KEYBOARD = {
  0x04: "A", 0x05: "B", 0x06: "C", 0x07: "D", 0x08: "E", 0x09: "F", 0x0a: "G",
  0x0b: "H", 0x0c: "I", 0x0d: "J", 0x0e: "K", 0x0f: "L", 0x10: "M", 0x11: "N",
  0x12: "O", 0x13: "P", 0x14: "Q", 0x15: "R", 0x16: "S", 0x17: "T", 0x18: "U",
  0x19: "V", 0x1a: "W", 0x1b: "X", 0x1c: "Y", 0x1d: "Z",
  0x1e: "1", 0x1f: "2", 0x20: "3", 0x21: "4", 0x22: "5",
  0x23: "6", 0x24: "7", 0x25: "8", 0x26: "9", 0x27: "0",
  0x28: "Enter", 0x29: "Esc", 0x2a: "Bksp", 0x2b: "Tab", 0x2c: "Space",
  0x2d: "-", 0x2e: "=", 0x2f: "[", 0x30: "]", 0x31: "\\", 0x33: ";", 0x34: "'",
  0x35: "`", 0x36: ",", 0x37: ".", 0x38: "/", 0x39: "Caps",
  0x3a: "F1", 0x3b: "F2", 0x3c: "F3", 0x3d: "F4", 0x3e: "F5", 0x3f: "F6",
  0x40: "F7", 0x41: "F8", 0x42: "F9", 0x43: "F10", 0x44: "F11", 0x45: "F12",
  0x46: "PrtSc", 0x47: "ScrLk", 0x48: "Pause", 0x49: "Ins", 0x4a: "Home",
  0x4b: "PgUp", 0x4c: "Del", 0x4d: "End", 0x4e: "PgDn",
  0x4f: "→", 0x50: "←", 0x51: "↓", 0x52: "↑",
  0x53: "NumLk", 0x54: "KP /", 0x55: "KP *", 0x56: "KP -", 0x57: "KP +",
  0x58: "KP Ent", 0x59: "KP 1", 0x5a: "KP 2", 0x5b: "KP 3", 0x5c: "KP 4",
  0x5d: "KP 5", 0x5e: "KP 6", 0x5f: "KP 7", 0x60: "KP 8", 0x61: "KP 9",
  0x62: "KP 0", 0x63: "KP .",
  0x65: "Menu", 0x66: "Power",
  0xe0: "LCtrl", 0xe1: "LShift", 0xe2: "LAlt", 0xe3: "LGui",
  0xe4: "RCtrl", 0xe5: "RShift", 0xe6: "RAlt", 0xe7: "RGui",
};

const CONSUMER = {
  0x00b5: "Next", 0x00b6: "Prev", 0x00b7: "Stop", 0x00cd: "Play/Pause",
  0x00e2: "Mute", 0x00e9: "Vol +", 0x00ea: "Vol -",
  0x0070: "Bright +", 0x0071: "Bright -",
  0x0223: "Home", 0x0224: "Back",
};

/** A usage as ZMK packs it, back into something readable. */
export function usageName(param) {
  if (!param) return null;
  const page = (param >>> 16) & 0xffff;
  const id = param & 0xffff;
  if (page === PAGE_KEY) return KEYBOARD[id] ?? `0x${id.toString(16)}`;
  if (page === PAGE_CONSUMER) return CONSUMER[id] ?? `0x${id.toString(16)}`;
  // A bare id with no page is how some keymaps are written; assume keyboard.
  if (page === 0) return KEYBOARD[id] ?? `0x${id.toString(16)}`;
  return `${page.toString(16)}:${id.toString(16)}`;
}

/** The reverse, for the picker. Keyboard page only — it is what people bind. */
export const KEY_CHOICES = Object.entries(KEYBOARD)
  .map(([id, name]) => ({ name, param: (PAGE_KEY << 16) | Number(id) }));

export const MEDIA_CHOICES = Object.entries(CONSUMER)
  .map(([id, name]) => ({ name, param: (PAGE_CONSUMER << 16) | Number(id) }));

// node src/keycodes.js
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("keycodes.js")) {
  const eq = (a, b, m) => console.assert(a === b, `${m}: got ${JSON.stringify(a)}`);
  eq(usageName((0x07 << 16) | 0x04), "A", "keyboard page A");
  eq(usageName((0x07 << 16) | 0x28), "Enter", "keyboard page Enter");
  eq(usageName((0x0c << 16) | 0x00cd), "Play/Pause", "consumer page");
  eq(usageName(0x04), "A", "a bare id is read as keyboard");
  eq(usageName((0x07 << 16) | 0xfe), "0xfe", "an unknown usage shows its number");
  eq(usageName(0), null, "no binding parameter");
  eq(KEY_CHOICES.find((c) => c.name === "Space").param, (0x07 << 16) | 0x2c, "choices round-trip");
  console.log(`keycodes.js self-check OK (${KEY_CHOICES.length} keys, ${MEDIA_CHOICES.length} media)`);
}
