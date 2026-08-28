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

// The shell is not ready the instant the transport opens. The previous UI
// waited, then probed with a junk command until the shell answered, and only
// then sent anything real — without that, the first command (rtcfg list) goes
// out into the void and times out. These are its numbers.
const SETTLE_MS = { usb: 2000, ble: 1500 };
const PROBE_TIMEOUT_MS = 3000;
const PROBE_GAP_MS = 500;
const HANDSHAKE_MS = 25000;

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
    await this.handshake();
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
    // A dropped GATT link leaves the app thinking it is still connected.
    dev.addEventListener("gattserverdisconnected", () => {
      this.shell = this.bleDevice = null;
      this.kind = null;
      for (const fn of this.listeners) fn({ dir: "recv", text: "Bluetooth disconnected", at: Date.now() });
    });
    await this.handshake();
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

  /**
   * Wait for the shell, then prove it is listening before anything real is
   * sent. `__init` is not a command, so a shell that is up answers
   * "__init: command not found" — which is exactly the reply we want.
   */
  async handshake() {
    await sleep(SETTLE_MS[this.kind] ?? 1500);
    const deadline = Date.now() + HANDSHAKE_MS;
    for (;;) {
      try {
        const out = await this.send("__init", { timeout: PROBE_TIMEOUT_MS });
        if (/command not found/i.test(out)) break;
      } catch {
        /* no answer yet; the device is still coming up */
      }
      if (Date.now() > deadline) throw new Error("The device did not respond. Try reconnecting.");
      await sleep(PROBE_GAP_MS);
    }
    // Echo pollutes every reply we parse, so turn it off once we are talking.
    try { await this.send("shell echo off"); } catch { /* older firmware lacks it */ }
  }

  /** Send one shell command, resolve with its (cleaned) output. Serialised. */
  send(cmd, { timeout = CMD_TIMEOUT_MS } = {}) {
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

      const out = await this.awaitPrompt(cmd, timeout);
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

  async awaitPrompt(cmd, timeout = CMD_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
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
