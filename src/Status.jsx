import { useEffect, useState } from "react";
import { device } from "./device.js";
import { parseBoardStatus, parseOutput } from "./protocol.js";

// Live device readout for the header: which endpoint is carrying the pointer,
// firmware version, and battery. Polled in the background like the original —
// output changes often, status rarely.

const OUTPUT_POLL_MS = 3000;
const STATUS_POLL_MS = 300000;

export default function Status({ live, transport, onFirmware }) {
  const [info, setInfo] = useState({ version: null, battery: undefined });
  // The parsed endpoint, and the reply it came from. The battery gauge already
  // carries its raw `board status` in a tooltip; the icons need the same,
  // because "the USB icon is lit while I am on Bluetooth" has two causes that
  // look identical — the board really is sending HID over the cable, which ZMK
  // prefers whenever one is plugged in, or we misread its answer.
  const [output, setOutput] = useState(null);
  const [outputRaw, setOutputRaw] = useState(null);
  // Seeded from the transport App opened and corrected by the poll, which is
  // what catches a link dropping underneath us. Neither alone is enough: the
  // prop cannot see a drop, and the poll cannot see a new session until its
  // next tick — which is how a BLE session spent its first seconds labelled
  // USB after a USB one.
  const [kind, setKind] = useState(transport ?? null);

  useEffect(() => {
    if (!live) {
      // Demo mode has no device to ask. Show the gauge empty rather than
      // inventing a number that looks like a real reading.
      setInfo({ version: null, battery: undefined });
      setOutput(null);
      setKind(null);
      onFirmware?.(null);
      return;
    }
    setKind(transport ?? device.kind);
    // Last session's answer is not this session's. Clearing it means the icons
    // go dark until the first poll rather than showing the old endpoint.
    setOutput(null);
    setOutputRaw(null);
    let stop = false;
    const timers = [];

    /**
     * Yield to the user's own commands, but come straight back — skipping
     * outright meant the first read landed during the initial settings load
     * and then waited a full interval, which for status is five minutes.
     */
    const poll = (fn, every) => {
      const run = async () => {
        if (stop) return;
        if (device.pending || device.streaming) {
          timers.push(setTimeout(run, 300));
          return;
        }
        await fn();
        if (!stop) timers.push(setTimeout(run, every));
      };
      run();
    };

    poll(async () => {
      try {
        const status = await device.send("board status");
        const version = status.includes("Control the device")
          ? await device.send("board version")
          : null;
        if (stop) return;
        const parsed = parseBoardStatus(status, version);
        // Keep the raw reply so the gauge can show exactly what it came from.
        parsed.raw = status.trim();
        setInfo(parsed);
        onFirmware?.(parsed.version);
      } catch { /* a poll that misses is not worth reporting */ }
    }, STATUS_POLL_MS);

    poll(async () => {
      try {
        const reply = await device.send("board output");
        const o = parseOutput(reply);
        if (stop) return;
        setOutputRaw(reply.trim());
        if (o) setOutput(o);
        // Re-read every cycle: a dropped BLE link clears device.kind, and the
        // label has to follow it rather than keep claiming a live connection.
        setKind(device.kind);
      } catch { /* same */ }
    }, OUTPUT_POLL_MS);

    return () => { stop = true; timers.forEach(clearTimeout); };
  }, [live, transport, onFirmware]);

  // Only ever what the transport actually is. The old form fell back to "USB"
  // for any live connection, so a BLE session whose kind had not been read yet
  // — or had been cleared by a drop — still announced itself as USB.
  const link = kind === "ble" ? "BLE" : kind === "usb" ? "USB" : null;

  return (
    <div className="status" role="status" aria-label="Device status">
      <span
        className="status__eps"
        title={
          'Where the board is sending the pointer — not the link this app is '
          + 'configuring over. A board with a cable plugged in reports USB here '
          + 'even while you configure it over Bluetooth.'
          + (outputRaw ? `

From "board output":
${outputRaw}` : "")
        }
        aria-label="Pointer output"
      >
        <Endpoint icon="usb" label="USB" on={output === "USB"} />
        <Endpoint icon="ble" label="Bluetooth" on={output === "BLE"} />
        <Endpoint icon="esb" label="Dongle" on={output === "ESB"} />
      </span>

      {info.version && <span className="status__ver" title="Firmware version">v{info.version}</span>}

      {info.battery !== null && <Battery level={info.battery} raw={info.raw} />}

      {link && (
        <span
          className="status__link"
          title={`This app is configuring the device over ${link}. The icons to the left are where the board sends the pointer, which is a separate setting.`}
        >
          {/* "via" is doing real work: a bare "USB" beside three endpoint icons
              reads as a fourth endpoint, and the two answer different
              questions — this is the link we configure over, those are where
              the pointer goes. */}
          via {link}
        </span>
      )}
    </div>
  );
}

function Endpoint({ icon, label, on }) {
  return (
    <span
      className={"status__ep" + (on ? " is-on" : "")}
      title={on ? `${label} — active output` : label}
    >
      <Icon name={icon} />
      <span className="sr-only">{label}{on ? " active" : " inactive"}</span>
    </span>
  );
}

/** Always drawn: an empty gauge reading "--" beats no gauge while we wait. */
function Battery({ level, raw }) {
  const known = typeof level === "number";
  const bars = known ? Math.max(0, Math.min(8, Math.round((level / 100) * 8))) : 0;
  const band = !known ? "none" : level <= 15 ? "low" : level <= 30 ? "mid" : "high";
  return (
    <span
      className={"batt batt--" + band}
      title={
        known
          ? `Battery ${level}% — from "board status":
${raw ?? ""}`
          : "Battery level not reported yet"
      }
    >
      <span className="batt__shell">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className={"batt__cell" + (i < bars ? " is-on" : "")} />
        ))}
      </span>
      <span className="batt__cap" />
      <span className="batt__pct">{known ? `${level}%` : "--"}</span>
      <span className="sr-only">{known ? `Battery ${level} percent` : "Battery unknown"}</span>
    </span>
  );
}

/* Four inline icons beat pulling in an icon package for four glyphs. */
function Icon({ name }) {
  const common = {
    width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round",
    strokeLinejoin: "round", "aria-hidden": true,
  };
  if (name === "usb") {
    return (
      <svg {...common}>
        <circle cx="10" cy="7" r="1" /><circle cx="4" cy="20" r="1" />
        <path d="M4.7 19.3 19 5" /><path d="m21 3-3 1 2 2Z" />
        <path d="M9.26 7.68 5 12l2 5" /><path d="M10 14v4h4l3-3" />
      </svg>
    );
  }
  if (name === "ble") {
    return (
      <svg {...common}>
        <path d="m7 7 10 10-5 5V2l5 5L7 17" />
      </svg>
    );
  }
  return (   // esb / dongle: a broadcast glyph
    <svg {...common}>
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </svg>
  );
}
