// Transport + shell protocol for ZMK trackball firmware.
// Behaviour here is calibrated against real hardware (prompt strings, the
// word-by-word USB write, BLE chunk size, inter-command gap). Don't "tidy"
// these constants — the device shell depends on them.

const USB = { usbVendorId: 17, usbProductId: 7, baudRate: 460800 };
const BLE_SERVICE = "c901c4e9-5770-4bf1-96b2-2dd287813e6e";
const BLE_SHELL = "c901c4ea-5770-4bf1-96b2-2dd287813e6e";
const BLE_DATA = "c901c4eb-5770-4bf1-96b2-2dd287813e6e";

const PROMPTS = ["endgame$ ", "uart:~$ ", "zmk$", "zmk:~$"];
const BLE_CHUNK = 96;      // MTU-safe write size
const CMD_GAP_MS = 200;    // shell needs breathing room between commands
const CMD_TIMEOUT_MS = 10000;

// The shell is not ready the instant the transport opens. The previous UI
// waited, then probed with a junk command until the shell answered, and only
// then sent anything real — without that, the first command (rtcfg list) goes
// out into the void and times out. These are its numbers.
const SETTLE_MS = { usb: 2000, ble: 1500 };
const PROBE_TIMEOUT_MS = 2500;
const PROBE_GAP_MS = 300;
const HANDSHAKE_MS = 25000;

// A reply is finished when the prompt arrives — but not every firmware and
// transport prints a prompt we recognise, and over BLE that left the first
// command hanging until it threw. The previous UI never threw: it also
// accepted "the device has stopped talking" as the end of a reply. This is
// that fallback, at a tighter gap since replies normally arrive in one burst.
const QUIET_MS = 1200;

// Zephyr shells do not agree on what ends a line. The previous UI only ever
// sent LF, which is right for the USB console; if the BLE backend wants CR it
// simply never sees a command. Probe with each until one answers.
const LINE_ENDINGS = ["\n", "\r", "\r\n"];

/** Named reads, since these live on the prototype and do not enumerate. */
function describeProps(ch) {
  const p = ch.properties;
  if (!p) return "unknown";
  const on = ["notify", "indicate", "read", "write", "writeWithoutResponse"].filter((k) => p[k]);
  return on.join(", ") || "none";
}

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
    this.shell = null;     // BLE shell characteristic
    this.data = null;      // BLE data channel, notify-only
    this.buffer = "";
    this.tail = Promise.resolve();  // command queue
    this.pending = 0;               // lets background polls yield to real work
    this.lastByteAt = 0;            // for quiet-based reply completion
    this.lastCmdAt = 0;
    this.listeners = new Set();
  }

  get connected() { return !!(this.port || this.shell); }

  onLog(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  log(dir, text) { for (const fn of this.listeners) fn({ dir, text, at: Date.now() }); }

  async connectUSB() {
    // A previous failed attempt must not leave a transport behind: send()
    // would then write USB commands into a dead BLE characteristic, which is
    // why USB only worked again after a page refresh.
    await this.disconnect();
    this.closing = false;   // after disconnect, which sets it
    const port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: USB.usbVendorId }],
    });
    await port.open({ baudRate: USB.baudRate });
    this.port = port;
    this.kind = "usb";
    this.readLoop();
    await this.settle();
    return this;
  }

  async connectBLE() {
    await this.disconnect();
    this.closing = false;
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE] }],
      optionalServices: [BLE_SERVICE],
    });
    this.log("send", `Selected "${dev.name ?? "unnamed device"}"`);

    const server = await dev.gatt.connect();
    this.log("recv", "GATT connected");
    const svc = await server.getPrimaryService(BLE_SERVICE);

    // Enumerate rather than fetch by uuid: it gives a clearer failure when the
    // shell characteristic is absent, and we need the data one anyway.
    const chars = new Map((await svc.getCharacteristics()).map((c) => [c.uuid, c]));
    this.log("recv", `Characteristics: ${[...chars.keys()].join(", ") || "none"}`);

    this.shell = chars.get(BLE_SHELL);
    if (!this.shell) throw new Error(`Shell characteristic ${BLE_SHELL} not found on this device.`);

    // BluetoothCharacteristicProperties exposes getters on its prototype, so
    // Object.entries() sees nothing. Read the ones that matter by name.
    this.log("recv", `Shell supports: ${describeProps(this.shell)}`);

    this.decoder = new TextDecoder();
    this.shell.addEventListener("characteristicvaluechanged", (e) => {
      const text = this.decoder.decode(e.target.value);
      this.buffer += text;
      this.lastByteAt = Date.now();
      this.sawShellBytes = true;
    });
    await this.shell.startNotifications();
    this.log("recv", "Subscribed to the shell channel");

    // The previous UI subscribes to the data channel too, before it says a
    // word to the shell. Some firmware will not start talking until both
    // subscriptions exist, so match it.
    this.data = chars.get(BLE_DATA) ?? null;
    if (this.data) {
      try {
        // If the device answers here instead of on the shell, that is the
        // whole mystery, so watch it rather than ignoring it.
        this.data.addEventListener("characteristicvaluechanged", (e) => {
          if (this.sawDataBytes) return;
          this.sawDataBytes = true;
          this.log("recv", `Data channel produced: ${JSON.stringify(new TextDecoder().decode(e.target.value))}`);
        });
        await this.data.startNotifications();
        this.log("recv", "Subscribed to the data channel");
      } catch (err) {
        this.log("recv", `Data channel not subscribed: ${err.message}`);
      }
    } else {
      this.log("recv", "No data channel on this device");
    }
    if (this.data) this.log("recv", `Data supports: ${describeProps(this.data)}`);

    this.bleDevice = dev;
    this.kind = "ble";
    // A dropped GATT link leaves the app thinking it is still connected.
    dev.addEventListener("gattserverdisconnected", () => {
      const ours = this.closing;
      this.shell = this.bleDevice = this.data = null;
      this.kind = null;
      this.log("recv", ours ? "Bluetooth closed" : "Bluetooth link dropped by the device");
    });
    await this.settle();
    return this;
  }

  async readLoop() {
    const decoder = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.buffer += decoder.decode(value, { stream: true });
          this.lastByteAt = Date.now();
        }
      }
    } catch {
      /* reader cancelled on disconnect */
    }
  }

  async disconnect() {
    this.closing = true;   // so the drop handler knows this was us
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { this.reader?.releaseLock(); } catch { /* already released */ }
    try { await this.port?.close(); } catch { /* already closed */ }
    try { await this.shell?.stopNotifications(); } catch { /* already stopped */ }
    try { this.bleDevice?.gatt?.disconnect(); } catch { /* already gone */ }
    this.port = this.shell = this.reader = this.bleDevice = this.data = null;
    this.kind = null;
    // Leftovers here would be read as the next connection's first reply.
    this.buffer = "";
    this.lastByteAt = 0;
    this.bleWrite = null;
    this.lineEnding = null;
    this.sawShellBytes = this.sawDataBytes = false;
  }

  /** Handshake, tearing the transport down if the device never answers. */
  async settle() {
    try {
      await this.handshake();
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  /**
   * Wait for the shell, then prove it is listening before anything real is
   * sent. `__init` is not a command, so a shell that is up answers
   * "__init: command not found" — which is the reply we are looking for.
   */
  async handshake() {
    this.log("send", `Waiting ${SETTLE_MS[this.kind] ?? 1500}ms for the shell…`);
    await sleep(SETTLE_MS[this.kind] ?? 1500);
    const deadline = Date.now() + HANDSHAKE_MS;
    let lastError = null;
    let attempt = 0;
    for (;;) {
      this.lineEnding = LINE_ENDINGS[attempt % LINE_ENDINGS.length];
      attempt++;
      try {
        const out = await this.send("__init", { timeout: PROBE_TIMEOUT_MS });
        if (/command not found/i.test(out)) {
          this.log("recv", `Shell answered with ${JSON.stringify(this.lineEnding)} line endings`);
          break;
        }
        // Wording varies between firmwares. Anything coming back at all means
        // the shell is up and listening, which is all we needed to establish.
        if (out.trim().length > 0) {
          this.log("recv", "Shell is responding; continuing.");
          break;
        }
      } catch (err) {
        // Swallowing this is what made a genuine write failure look like an
        // unresponsive device. Record it; the Logs tab shows it.
        lastError = err;
        this.log("recv", `No reply to ${JSON.stringify(this.lineEnding)} (${err.message})`);
      }
      if (Date.now() > deadline) {
        if (!this.sawShellBytes) {
          this.log("recv", this.sawDataBytes
            ? "The shell channel never produced a byte, but the data channel did."
            : "Neither channel produced a byte. Writes left, nothing came back.");
        }
        throw new Error(
          lastError && !/^Timed out/.test(lastError.message)
            ? `The device did not respond: ${lastError.message}`
            : "The device did not respond. Try reconnecting.",
        );
      }
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
      this.lastByteAt = 0;
      this.log("send", cmd);
      const bytes = new TextEncoder().encode(cmd + (this.lineEnding ?? "\n"));

      if (this.kind === "ble") {
        for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
          await this.writeBle(bytes.subarray(i, i + BLE_CHUNK));
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

  /**
   * Write-without-response is what the previous UI uses, but a characteristic
   * that does not advertise it throws — and inside the handshake that error
   * was invisible, so the connection just looked unresponsive. Fall back to a
   * plain write, and remember which one worked.
   */
  async writeBle(chunk) {
    if (!this.bleWrite) {
      const p = this.shell.properties ?? {};
      // Skip straight to the plain write when the characteristic says it
      // cannot do the other one, rather than throwing once to find out.
      if (p.writeWithoutResponse === false && p.write) this.bleWrite = "withResponse";
    }
    if (this.bleWrite !== "withResponse") {
      try {
        await this.shell.writeValueWithoutResponse(chunk);
        this.bleWrite = "withoutResponse";
        return;
      } catch (err) {
        if (this.bleWrite === "withoutResponse") throw err;
        this.log("recv", `Write without response failed (${err.message}); using a plain write.`);
      }
    }
    await this.shell.writeValue(chunk);
    this.bleWrite = "withResponse";
  }

  async awaitPrompt(cmd, timeout = CMD_TIMEOUT_MS) {
    const started = Date.now();
    const deadline = started + timeout;
    for (;;) {
      const clean = stripAnsi(this.buffer);
      if (PROMPTS.some((p) => clean.includes(p))) return tidy(clean, cmd);

      // Something came back and then stopped: treat that as the whole reply,
      // even without a prompt we know.
      const quiet = this.lastByteAt && Date.now() - this.lastByteAt > QUIET_MS;
      if (clean.length > 0 && quiet) return tidy(clean, cmd);

      if (Date.now() > deadline) {
        // Anything at all beats an exception; only true silence is an error.
        if (clean.length > 0) return tidy(clean, cmd);
        throw new Error(`Timed out: ${cmd}`);
      }
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

// node src/device.js -> self-check for reply completion
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("device.js")) {
  const d = new Device();
  d.kind = "usb";
  d.port = {};                     // enough for `connected`

  const check = async (name, setup, expect) => {
    d.buffer = "";
    d.lastByteAt = 0;
    setup(d);
    try {
      const out = await d.awaitPrompt("rtcfg list", 400);
      console.assert(expect.text !== undefined, `${name}: expected a throw, got "${out}"`);
      console.assert(out === expect.text, `${name}: got "${out}", wanted "${expect.text}"`);
    } catch (err) {
      console.assert(expect.throws, `${name}: unexpected throw ${err.message}`);
    }
  };

  // A prompt ends the reply immediately.
  await check("prompt", (x) => { x.buffer = "p2sm/x 1\nuart:~$ "; }, { text: "p2sm/x 1" });

  // No prompt, but the device stopped talking a while ago: take what we have.
  await check("quiet", (x) => {
    x.buffer = "p2sm/x 1";
    x.lastByteAt = Date.now() - (QUIET_MS + 200);
  }, { text: "p2sm/x 1" });

  // Still arriving: not finished yet, so fall through to the deadline and
  // return the partial rather than throwing away a real answer.
  await check("still arriving", (x) => {
    x.buffer = "p2sm/x 1";
    x.lastByteAt = Date.now();
  }, { text: "p2sm/x 1" });

  // Total silence is the only genuine failure.
  await check("silence", () => {}, { throws: true });

  // ANSI colour around a prompt must not hide it.
  await check("ansi prompt", (x) => { x.buffer = "ok\n\x1b[1;32muart:~$ \x1b[0m"; }, { text: "ok" });

  console.log("device.js self-check OK");
}
