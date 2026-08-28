// Transport + shell protocol for ZMK trackball firmware.
// Behaviour here is calibrated against real hardware (prompt strings, the
// word-by-word USB write, BLE chunk size, inter-command gap). Don't "tidy"
// these constants — the device shell depends on them.

const USB = { usbVendorId: 17, usbProductId: 7, baudRate: 460800 };
const BLE_SERVICE = "c901c4e9-5770-4bf1-96b2-2dd287813e6e";
const BLE_SHELL = "c901c4ea-5770-4bf1-96b2-2dd287813e6e";

const PROMPTS = ["endgame$ ", "uart:~$ ", "zmk$", "zmk:~$"];
const BLE_CHUNK = 96;      // MTU-safe write size
const CMD_GAP_MS = 200;    // shell needs breathing room between commands
const CMD_TIMEOUT_MS = 10000;

const stripAnsi = (s) => s.replace(/\x1b\[[\d;]*[A-Za-z]/g, "");

export const supported = {
  usb: typeof navigator !== "undefined" && !!navigator.serial,
  ble: typeof navigator !== "undefined" && !!navigator.bluetooth,
};

/** One live connection. Only one command is in flight at a time. */
class Device {
  constructor() {
    this.kind = null;      // 'usb' | 'ble'
    this.port = null;      // SerialPort
    this.shell = null;     // BLE characteristic
    this.buffer = "";
    this.tail = Promise.resolve();  // command queue
    this.pending = 0;               // lets background polls yield to real work
    this.lastCmdAt = 0;
    this.listeners = new Set();
  }

  get connected() { return !!(this.port || this.shell); }

  onLog(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  log(dir, text) { for (const fn of this.listeners) fn({ dir, text, at: Date.now() }); }

  async connectUSB() {
    const port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: USB.usbVendorId }],
    });
    await port.open({ baudRate: USB.baudRate });
    this.port = port;
    this.kind = "usb";
    this.readLoop();
    return this;
  }

  async connectBLE() {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE] }],
    });
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(BLE_SERVICE);
    this.shell = await svc.getCharacteristic(BLE_SHELL);
    this.decoder = new TextDecoder();
    this.shell.addEventListener("characteristicvaluechanged", (e) => {
      this.buffer += this.decoder.decode(e.target.value);
    });
    await this.shell.startNotifications();
    this.bleDevice = dev;
    this.kind = "ble";
    return this;
  }

  async readLoop() {
    const decoder = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      /* reader cancelled on disconnect */
    }
  }

  async disconnect() {
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { this.reader?.releaseLock(); } catch { /* already released */ }
    try { await this.port?.close(); } catch { /* already closed */ }
    try { await this.shell?.stopNotifications(); } catch { /* already stopped */ }
    try { this.bleDevice?.gatt?.disconnect(); } catch { /* already gone */ }
    this.port = this.shell = this.reader = this.bleDevice = null;
    this.kind = null;
  }

  /** Send one shell command, resolve with its (cleaned) output. Serialised. */
  send(cmd) {
    const run = async () => {
      if (!this.connected) throw new Error("Not connected");
      const wait = CMD_GAP_MS - (Date.now() - this.lastCmdAt);
      if (wait > 0) await sleep(wait);

      this.buffer = "";
      this.log("send", cmd);
      const bytes = new TextEncoder().encode(cmd + "\n");

      if (this.shell) {
        for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
          await this.shell.writeValueWithoutResponse(bytes.subarray(i, i + BLE_CHUNK));
          if (i + BLE_CHUNK < bytes.length) await sleep(20);
        }
      } else {
        const writer = this.port.writable.getWriter();
        try {
          // The shell's line editor drops bytes if a long command lands in one
          // burst, so feed it a word at a time.
          const enc = new TextEncoder();
          for (const word of cmd.split(" ")) await writer.write(enc.encode(word + " "));
          await writer.write(enc.encode("\n"));
        } finally {
          writer.releaseLock();
        }
      }

      const out = await this.awaitPrompt(cmd);
      this.lastCmdAt = Date.now();
      this.log("recv", out);
      return out;
    };

    // Chain onto the queue; a failed command must not poison later ones.
    this.pending++;
    const done = () => { this.pending--; };
    const result = this.tail.then(run, run);
    result.then(done, done);
    this.tail = result.catch(() => {});
    return result;
  }

  async awaitPrompt(cmd) {
    const deadline = Date.now() + CMD_TIMEOUT_MS;
    for (;;) {
      const clean = stripAnsi(this.buffer);
      if (PROMPTS.some((p) => clean.includes(p))) return tidy(clean, cmd);
      if (Date.now() > deadline) throw new Error(`Timed out: ${cmd}`);
      await sleep(20);
    }
  }
}

/** Drop the echoed command and the trailing prompt from a response. */
function tidy(text, cmd) {
  let out = text;
  for (const p of PROMPTS) out = out.split(p).join("");
  return out
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() && l.trim() !== cmd.trim())
    .join("\n")
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const device = new Device();
