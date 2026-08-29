import { useCallback, useEffect, useRef, useState } from "react";
import { device } from "./device.js";
import { frameReader, parseSubcommands, unsupported } from "./protocol.js";
import Loading from "./Loading.jsx";

// The live sensor image. `sensor stream --on` pushes one frame per capture as
// hex rows; we colour them and paint them to a canvas.
//
// Needs firmware whose sensor driver was built with frame capture. Which
// driver that is depends on the sensor the board carries, and some expose no
// frame capture at all — so nothing here names one. A board without the
// subcommand answers with the `sensor` command's own help, which is what the
// probe on mount looks for.
//
// Frames land through device.onRaw rather than device.send, because this is the
// one exchange that is not request/response. While it runs, device.streaming
// tells the background pollers to stand down and the transport to keep those
// bytes out of the command buffer.

/** Build a 256-entry RGB lookup table from [position, r, g, b] stops. */
function ramp(stops) {
  const lut = new Uint8ClampedArray(768);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let n = 1;
    while (n < stops.length - 1 && stops[n][0] < t) n++;
    const a = stops[n - 1];
    const b = stops[n];
    const span = b[0] - a[0];
    const f = span > 0 ? (t - a[0]) / span : 0;
    lut[i * 3] = a[1] + (b[1] - a[1]) * f;
    lut[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
    lut[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
  }
  return lut;
}

const MAPS = [
  { key: "ironbow", label: "Ironbow", stops: [[0, 0, 0, 0], [0.25, 60, 10, 110], [0.5, 190, 40, 60], [0.7, 240, 120, 10], [0.88, 250, 220, 40], [1, 255, 255, 255]] },
  { key: "coolwarm", label: "Blue–red", stops: [[0, 40, 90, 255], [0.5, 240, 240, 240], [1, 220, 40, 40]] },
  { key: "rainbow", label: "Rainbow", stops: [[0, 0, 0, 140], [0.15, 0, 80, 255], [0.35, 0, 220, 220], [0.55, 60, 230, 60], [0.75, 240, 230, 40], [0.9, 250, 140, 20], [1, 220, 30, 30]] },
  { key: "grey", label: "Grey", stops: [[0, 0, 0, 0], [1, 255, 255, 255]] },
].map((m) => ({ ...m, lut: ramp(m.stops) }));

/** The same ramp as a CSS gradient, so each button shows what it does. */
const swatch = (m) => `linear-gradient(to right, ${
  m.stops.map(([p, r, g, b]) => `rgb(${r},${g},${b}) ${(p * 100).toFixed(0)}%`).join(", ")})`;

const FPS_WINDOW = 12;

/**
 * A reply is not the same as an accepted command. A firmware without this
 * subcommand prints the parent command's help — "sensor - Sensor Diagnostics",
 * then "Subcommands:" — rather than an error, so treating any non-empty reply
 * as success shows a blank box forever.
 */
const streamAccepted = (reply) =>
  !unsupported(reply) && !/subcommands|usage:/i.test(String(reply ?? ""));

const firstLine = (text) => String(text ?? "").trim().split("\n")[0] ?? "";

/** Two moving blobs, in the wire format a board sends, for demo mode. */
function demoFrames(t) {
  const W = 30;
  const H = 30;
  let out = "";
  for (const id of [0, 1]) {
    const cx = W / 2 + Math.cos(t + id * 2) * 6;
    const cy = H / 2 + Math.sin(t * 1.3 + id) * 6;
    const rows = [];
    for (let y = 0; y < H; y++) {
      let row = "";
      for (let x = 0; x < W; x++) {
        const v = Math.max(0, 220 - Math.hypot(x - cx, y - cy) * 22) + Math.random() * 18;
        row += Math.min(255, Math.round(v)).toString(16).padStart(2, "0");
      }
      rows.push(row);
    }
    out += `F ${id} ${Math.round(t * 100).toString(16)}\n${rows.join("\n")}\nEND\n`;
  }
  return out;
}

export default function Heatmap({ live, onNote }) {
  const [on, setOn] = useState(false);
  const [map, setMap] = useState("ironbow");
  const [auto, setAuto] = useState(true);
  const [blur, setBlur] = useState(false);
  const [error, setError] = useState(null);
  // null while unknown, then { ok } or { ok: false, subs } from the board.
  const [support, setSupport] = useState(null);
  // Which sensors have actually sent a frame. A trackball has two, and the
  // frame header names which is which; painting both into one canvas made them
  // fight over it.
  const [ids, setIds] = useState([]);

  const views = useRef(new Map());   // id -> { canvas, meta, scratch, times }
  const lut = useRef(MAPS[0].lut);
  const autoRef = useRef(true);
  const blurRef = useRef(false);

  useEffect(() => { lut.current = MAPS.find((m) => m.key === map).lut; }, [map]);
  useEffect(() => { autoRef.current = auto; }, [auto]);
  useEffect(() => { blurRef.current = blur; }, [blur]);

  const slot = (id) => {
    if (!views.current.has(id)) views.current.set(id, { canvas: null, meta: null, scratch: null, times: [] });
    return views.current.get(id);
  };

  /**
   * Paint one frame into its own sensor's canvas. Deliberately not React
   * state: frames arrive twenty times a second per sensor, and routing that
   * through a re-render would repaint the whole settings panel with them.
   */
  const draw = useCallback((frame) => {
    const v = views.current.get(frame.id);
    const view = v?.canvas;
    if (!view) return;
    const { width, height, data } = frame;

    if (!v.scratch) v.scratch = document.createElement("canvas");
    const scratch = v.scratch;
    if (scratch.width !== width || scratch.height !== height) {
      scratch.width = width;
      scratch.height = height;
    }
    const sctx = scratch.getContext("2d");
    const img = sctx.createImageData(width, height);

    // Auto gain stretches this frame's own range across the ramp, which is how
    // you see anything at all on a sensor that only ever reads 13-107. Off,
    // 0-255 stays fixed so brightness is comparable between frames.
    let lo = 0;
    let hi = 255;
    if (autoRef.current) {
      lo = 255; hi = 0;
      for (const n of data) { if (n < lo) lo = n; if (n > hi) hi = n; }
      if (hi <= lo) hi = lo + 1;
    }
    const scale = 255 / (hi - lo);
    const table = lut.current;
    for (let i = 0; i < data.length; i++) {
      const n = Math.max(0, Math.min(255, Math.round((data[i] - lo) * scale)));
      const p = i * 4;
      img.data[p] = table[n * 3];
      img.data[p + 1] = table[n * 3 + 1];
      img.data[p + 2] = table[n * 3 + 2];
      img.data[p + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);

    const ctx = view.getContext("2d");
    const box = view.getBoundingClientRect();
    if (view.width !== Math.round(box.width) || view.height !== Math.round(box.height)) {
      view.width = Math.max(1, Math.round(box.width));
      view.height = Math.max(1, Math.round(box.height));
    }
    // Blur off fits whole pixels, so the sensor grid stays square and crisp.
    const fit = Math.min(view.width / width, view.height / height);
    const zoom = blurRef.current ? fit : Math.max(1, Math.floor(fit));
    const w = width * zoom;
    const h = height * zoom;
    ctx.imageSmoothingEnabled = blurRef.current;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(scratch, 0, 0, width, height, (view.width - w) / 2, (view.height - h) / 2, w, h);

    v.times.push(performance.now());
    if (v.times.length > FPS_WINDOW) v.times.shift();
    const spread = v.times.at(-1) - v.times[0];
    const fps = v.times.length > 1 ? ((v.times.length - 1) / spread) * 1000 : 0;
    if (v.meta) {
      v.meta.textContent = `#${frame.seq} · ${lo}–${hi} · ${width}×${height} · ${fps.toFixed(0)} fps`;
    }
  }, []);

  /** A frame from a sensor we have not seen needs a canvas before it can land. */
  const accept = useCallback((frame) => {
    const v = slot(frame.id);
    if (!v.canvas) {
      setIds((prev) => (prev.includes(frame.id) ? prev : [...prev, frame.id].sort((a, b) => a - b)));
      return;   // this one frame is dropped; the next lands in the new canvas
    }
    draw(frame);
  }, [draw]);

  /**
   * Ask once, on mount, whether this firmware has the subcommand at all.
   * `--off` is harmless and also clears a stream a previous session left
   * running. A board without it answers with the parent command's help rather
   * than an error, so the reply has to be read, not just received.
   */
  useEffect(() => {
    if (!live) { setSupport({ ok: true }); return undefined; }
    let dead = false;
    (async () => {
      try {
        const out = await device.send("sensor stream --off", { timeout: 4000 });
        if (dead) return;
        setSupport(streamAccepted(out) ? { ok: true } : { ok: false, subs: parseSubcommands(out) });
      } catch {
        // No reply is not proof of absence; let the button be tried.
        if (!dead) setSupport({ ok: true });
      }
    })();
    return () => { dead = true; };
  }, [live]);

  /**
   * One path for both modes. Demo emits the same text a board would, through
   * the same tap, so the subscription, the reader and the chunk reassembly are
   * all exercised without hardware.
   */
  useEffect(() => {
    if (!on) return undefined;
    let stopped = false;
    let demo;
    let diag;
    let frames = 0;
    let sample = "";
    const reader = frameReader();
    const untap = device.onRaw((chunk) => {
      if (stopped) return;
      // Keep the opening bytes verbatim. If nothing decodes, this is the only
      // evidence of what the board actually sent, and a blank box is no help.
      if (sample.length < 400) sample += chunk;
      for (const frame of reader.push(chunk)) { frames++; accept(frame); }
    });

    setError(null);
    for (const v of views.current.values()) v.times = [];

    if (live) {
      (async () => {
        try {
          // Send before switching the transport into stream mode, so this
          // command's own reply still reaches the command buffer and can be
          // read. A board that starts flooding immediately may never show a
          // prompt, so a timeout here is not a failure.
          const out = await device.send("sensor stream --on", { timeout: 4000 });
          if (stopped) return;
          if (!streamAccepted(out)) {
            setError(`The board would not start the stream: ${firstLine(out) || "no reply"}`);
            setOn(false);
            return;
          }
        } catch { /* flooding board, no prompt — carry on */ }
        if (stopped) return;
        device.streaming = true;
        diag = setTimeout(() => {
          if (stopped || frames > 0) return;
          setError(sample.trim()
            ? `Streaming, but no frame decoded. The board is sending: ${JSON.stringify(sample.slice(0, 200))}`
            : "The board accepted the command but has sent nothing.");
        }, 5000);
      })();
    } else {
      device.streaming = true;
      let t = 0;
      demo = setInterval(() => { t += 0.12; device.emitRaw(demoFrames(t)); }, 60);
    }

    return () => {
      stopped = true;
      clearInterval(demo);
      clearTimeout(diag);
      untap();
      // Before the stop command, so its own reply is buffered and readable.
      device.streaming = false;
      reader.reset();
      if (live) {
        device.send("sensor stream --off").catch(() => {
          onNote?.("Could not stop the sensor stream — reconnect if replies look garbled.");
        });
      }
    };
  }, [on, live, accept, onNote]);

  // A stream you started by mouse should stop from the keyboard too.
  useEffect(() => {
    if (!on) return undefined;
    const key = (e) => {
      if (e.key === "Escape" || (e.key === " " && e.target === document.body)) {
        e.preventDefault();
        setOn(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [on]);

  // Until the probe answers we do not know whether this board can stream at
  // all, and offering Start before then means offering a button that may fail.
  if (live && support === null) {
    return (
      <div className="knobs">
        <h3 className="sec">Sensor image</h3>
        <Loading label="Checking whether this board can stream…" />
      </div>
    );
  }

  // A board without the subcommand cannot be talked into having it, so say so
  // once and name what it does have, rather than offering a button that fails.
  if (support && !support.ok) {
    return (
      <div className="knobs">
        <h3 className="sec">Sensor image</h3>
        {/* Deliberately does not name a driver. Which sensor a board carries
            (pmw3610, paw3395, …) decides which driver and which branch, and
            some of them have no frame capture to expose at all. */}
        <p className="panel__blurb">
          This firmware has no <code>sensor stream</code>, so there is no live
          image. It needs a driver built with frame capture, which depends on
          the sensor your board uses. Surface quality above is what this build
          reports.
        </p>
        {support.subs.length > 0 && (
          <p className="ctl__hint">
            Its <code>sensor</code> command offers: {support.subs.join(", ")}.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="knobs">
      <h3 className="sec">
        Sensor image {on && <span className="heat__live">LIVE</span>}
      </h3>
      <p className="panel__blurb">
        What each sensor sees, live. Useful for spotting a dirty lens, a ball the
        sensor cannot read, or an optical centre that needs adjusting.
      </p>

      {error && <p className="notice">{error}</p>}

      <div className="row row--wrap">
        <button className="btn" onClick={() => setOn((v) => !v)}>
          {on ? "Stop" : "Start streaming"}
        </button>
        {on && <span className="ctl__hint">Esc or Space stops it.</span>}
      </div>

      <div className="heat__maps" role="group" aria-label="Colour map">
        {MAPS.map((m) => (
          <button
            key={m.key}
            className={"heat__map" + (map === m.key ? " is-active" : "")}
            aria-pressed={map === m.key}
            onClick={() => setMap(m.key)}
          >
            <span className="heat__swatch" style={{ background: swatch(m) }} />
            {m.label}
          </button>
        ))}
      </div>

      <div className="heat__grid">
        {(ids.length ? ids : [null]).map((id) => (
          <div className="heat__cell" key={id ?? "empty"}>
            <div className="heat__head">
              <span className="gauges__name">{id === null ? "No sensor yet" : `Sensor #${id}`}</span>
              <span
                className="heat__meta"
                ref={(el) => { if (id !== null) slot(id).meta = el; }}
              />
            </div>
            <div className="heat">
              {id !== null && (
                <canvas
                  className="heat__view"
                  aria-label={`Sensor ${id} image`}
                  ref={(el) => { slot(id).canvas = el; }}
                />
              )}
              {!on && <p className="heat__idle">Not streaming</p>}
            </div>
          </div>
        ))}
      </div>

      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor="heat-auto">Auto gain</label>
        <button
          id="heat-auto" type="button" role="switch" aria-checked={auto}
          className="switch" onClick={() => setAuto((v) => !v)}
        >
          <span className="switch__dot" />
        </button>
      </div>
      <p className="ctl__hint">
        On, each frame is stretched across its own range so faint detail shows.
        Off, 0–255 stays fixed, so brightness is comparable between frames.
      </p>

      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor="heat-blur">Blur</label>
        <button
          id="heat-blur" type="button" role="switch" aria-checked={blur}
          className="switch" onClick={() => setBlur((v) => !v)}
        >
          <span className="switch__dot" />
        </button>
      </div>
      <p className="ctl__hint">
        Smooths between sensor pixels. Off shows the raw grid, which is what you
        want when judging the optical centre.
      </p>
    </div>
  );
}
