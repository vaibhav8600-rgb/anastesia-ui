import { useEffect, useState } from "react";
import { device } from "./device.js";
import { unsupported } from "./protocol.js";

// Live device readout for the header: which endpoint is carrying the pointer,
// firmware version, and battery. Polled in the background like the original —
// output changes often, status rarely.

const OUTPUT_POLL_MS = 5000;
const STATUS_POLL_MS = 300000;

/** `board status` -> firmware + battery, falling back to `board version`. */
export function parseBoardStatus(status, version) {
  const out = { version: null, battery: null };
  // An unsupported `board status` prints the command's help text instead.
  if (!status || unsupported(status) || status.includes("Control the device")) {
    out.version = version?.match(/Firmware version:\s*(\S+)/)?.[1] ?? null;
    return out;
  }
  out.version = status.match(/Firmware:\s*v?(\S+)/i)?.[1] ?? null;
  const b = status.match(/Battery:\s*(\d+)/i);
  if (b) out.battery = Number(b[1]);
  return out;
}

export function parseOutput(text) {
  return text?.match(/Output:\s*(USB|BLE|ESB)/i)?.[1]?.toUpperCase() ?? null;
}

export default function Status({ live }) {
  const [info, setInfo] = useState({ version: null, battery: null });
  const [output, setOutput] = useState(null);

  useEffect(() => {
    if (!live) {
      setInfo({ version: "1.4.4", battery: 95 });
      setOutput("BLE");
      return;
    }
    let stop = false;

    const readStatus = async () => {
      if (device.pending) return;   // never make the user wait behind a poll
      try {
        const status = await device.send("board status");
        const version = status.includes("Control the device")
          ? await device.send("board version")
          : null;
        if (!stop) setInfo(parseBoardStatus(status, version));
      } catch { /* a poll that misses is not worth reporting */ }
    };
    const readOutput = async () => {
      if (device.pending) return;
      try {
        const o = parseOutput(await device.send("board output"));
        if (!stop && o) setOutput(o);
      } catch { /* same */ }
    };

    readStatus();
    readOutput();
    const a = setInterval(readStatus, STATUS_POLL_MS);
    const b = setInterval(readOutput, OUTPUT_POLL_MS);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, [live]);

  const link = device.kind === "ble" ? "BLE" : live ? "USB" : null;

  return (
    <div className="status" role="status" aria-label="Device status">
      <Endpoint icon="usb" label="USB" on={output === "USB"} />
      <Endpoint icon="ble" label="Bluetooth" on={output === "BLE"} />
      <Endpoint icon="esb" label="Dongle" on={output === "ESB"} />

      {info.version && <span className="status__ver" title="Firmware version">v{info.version}</span>}

      {info.battery != null && <Battery level={info.battery} />}

      {link && (
        <span className="status__link" title={`Configuring over ${link}`}>{link}</span>
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

function Battery({ level }) {
  const bars = Math.max(0, Math.min(8, Math.round((level / 100) * 8)));
  const band = level <= 15 ? "low" : level <= 30 ? "mid" : "high";
  return (
    <span className={"batt batt--" + band} title={`Battery ${level}%`}>
      <span className="batt__shell">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className={"batt__cell" + (i < bars ? " is-on" : "")} />
        ))}
      </span>
      <span className="batt__cap" />
      <span className="batt__pct">{level}%</span>
      <span className="sr-only">Battery {level} percent</span>
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
