import { useCallback, useEffect, useRef, useState } from "react";
import { device } from "./device.js";
import { frameReader, unsupported } from "./protocol.js";

// The live sensor image. `sensor stream --on` pushes one frame per capture as
// hex rows; we colour them and paint them to a canvas.
//
// Frames land through device.onRaw rather than device.send, because this is
// the one exchange that is not request/response. While it runs, device.streaming
// tells the background pollers to stand down — a `board output` reply dropped
// into the middle of a frame corrupts it.

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
  { key: "ironbow", label: "Ironbow", lut: ramp([[0, 0, 0, 0], [0.25, 60, 10, 110], [0.5, 190, 40, 60], [0.7, 240, 120, 10], [0.88, 250, 220, 40], [1, 255, 255, 255]]) },
  { key: "coolwarm", label: "Blue–red", lut: ramp([[0, 40, 90, 255], [0.5, 240, 240, 240], [1, 220, 40, 40]]) },
  { key: "grey", label: "Grey", lut: ramp([[0, 0, 0, 0], [1, 255, 255, 255]]) },
];

const FPS_WINDOW = 12;

/** A moving blob, in the wire format a board sends, for demo mode. */
function demoFrame(t) {
  const W = 30;
  const H = 30;
  const cx = W / 2 + Math.cos(t) * 6;
  const cy = H / 2 + Math.sin(t * 1.3) * 6;
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = "";
    for (let x = 0; x < W; x++) {
      const v = Math.max(0, 220 - Math.hypot(x - cx, y - cy) * 22) + Math.random() * 18;
      row += Math.min(255, Math.round(v)).toString(16).padStart(2, "0");
    }
    rows.push(row);
  }
  return `F 0 ${Math.round(t * 100).toString(16)}\n${rows.join("\n")}\nEND\n`;
}

export default function Heatmap({ live, onNote }) {
  const [on, setOn] = useState(false);
  const [map, setMap] = useState("ironbow");
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState(null);

  const canvas = useRef(null);
  const meta = useRef(null);              // caption, written per frame, never state
  const off = useRef(null);                    // frame-sized scratch canvas
  const lut = useRef(MAPS[0].lut);
  const autoRef = useRef(true);
  const times = useRef([]);

  useEffect(() => { lut.current = MAPS.find((m) => m.key === map).lut; }, [map]);
  useEffect(() => { autoRef.current = auto; }, [auto]);

  /**
   * Paint one frame. Deliberately not React state: frames arrive faster than
   * the settings panel should ever re-render, so the canvas is written
   * directly and only the caption is throttled.
   */
  const draw = useCallback((frame) => {
    const view = canvas.current;
    if (!view) return;
    const { width, height, data } = frame;

    if (!off.current) off.current = document.createElement("canvas");
    const scratch = off.current;
    if (scratch.width !== width || scratch.height !== height) {
      scratch.width = width;
      scratch.height = height;
    }
    const sctx = scratch.getContext("2d");
    const img = sctx.createImageData(width, height);

    // Auto-contrast stretches this frame's own range across the ramp, which is
    // how you see anything at all on a sensor that only ever reads 20-60.
    // Absolute keeps 0-255 fixed, so brightness between frames is comparable —
    // the original always stretches, and hides that difference.
    let lo = 0;
    let hi = 255;
    if (autoRef.current) {
      lo = 255; hi = 0;
      for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
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

    // Fit whole pixels into the view, so the grid stays square and crisp.
    const ctx = view.getContext("2d");
    const box = view.getBoundingClientRect();
    if (view.width !== Math.round(box.width) || view.height !== Math.round(box.height)) {
      view.width = Math.max(1, Math.round(box.width));
      view.height = Math.max(1, Math.round(box.height));
    }
    const zoom = Math.max(1, Math.floor(Math.min(view.width / width, view.height / height)));
    const w = width * zoom;
    const h = height * zoom;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(scratch, 0, 0, width, height, (view.width - w) / 2, (view.height - h) / 2, w, h);

    times.current.push(performance.now());
    if (times.current.length > FPS_WINDOW) times.current.shift();
    const spread = times.current.at(-1) - times.current[0];
    const fps = times.current.length > 1 ? ((times.current.length - 1) / spread) * 1000 : 0;
    // Straight to the DOM. Through state this re-rendered the whole settings
    // panel once per frame, which is the one thing the comment above forbids.
    if (meta.current) {
      meta.current.textContent =
        `${width}×${height} · ${fps.toFixed(1)} fps · range ${lo}–${hi}`;
    }
  }, []);

  // Demo has no device, so synthesise a moving blob rather than an empty box.
  /**
   * One path for both modes. Demo used to call draw() directly with a
   * ready-made frame, which meant it exercised none of the plumbing that
   * matters — the subscription, the reader, the chunk reassembly — and a
   * missing device.onRaw sailed past every demo-mode check. Demo now emits the
   * same text a board would, through the same tap.
   */
  useEffect(() => {
    if (!on) return undefined;
    let stopped = false;
    let demo;
    const reader = frameReader();
    const untap = device.onRaw((chunk) => {
      if (stopped) return;
      for (const frame of reader.push(chunk)) draw(frame);
    });

    device.streaming = true;
    setError(null);
    times.current = [];

    if (live) {
      (async () => {
        try {
          const out = await device.send("sensor stream --on");
          if (unsupported(out)) {
            setError("This board does not stream the sensor image.");
            setOn(false);
          }
        } catch (err) {
          if (!stopped) { setError(err.message); setOn(false); }
        }
      })();
    } else {
      let t = 0;
      demo = setInterval(() => { t += 0.12; device.emitRaw(demoFrame(t)); }, 60);
    }

    return () => {
      stopped = true;
      clearInterval(demo);
      untap();
      device.streaming = false;
      reader.reset();
      // Best effort: if this fails the board keeps streaming, and the next
      // command's reply arrives buried in pixels, so say so.
      if (live) {
        device.send("sensor stream --off").catch(() => {
          onNote?.("Could not stop the sensor stream — reconnect if replies look garbled.");
        });
      }
    };
  }, [on, live, draw, onNote]);

  return (
    <div className="knobs">
      <h3 className="sec">Sensor image</h3>
      <p className="panel__blurb">
        What the sensor sees, live. Useful for spotting a dirty lens or a ball
        the sensor cannot read.
      </p>

      {error && <p className="notice">{error}</p>}

      <div className="heat">
        <canvas ref={canvas} className="heat__view" aria-label="Live sensor image" />
        {!on && <p className="heat__idle">Not streaming</p>}
      </div>

      <p className="heat__meta" ref={meta} aria-live="off" />

      <div className="row row--wrap">
        <button className="btn" onClick={() => setOn((v) => !v)}>
          {on ? "Stop" : "Start streaming"}
        </button>
        <select
          className="search search--slim"
          aria-label="Colour map"
          value={map}
          onChange={(e) => setMap(e.target.value)}
        >
          {MAPS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>

      <div className="ctl ctl--inline">
        <label className="ctl__label" htmlFor="heat-auto">Auto contrast</label>
        <button
          id="heat-auto"
          type="button"
          role="switch"
          aria-checked={auto}
          className="switch"
          onClick={() => setAuto((v) => !v)}
        >
          <span className="switch__dot" />
        </button>
      </div>
      <p className="ctl__hint">
        On, each frame is stretched across its own range so faint detail shows.
        Off, 0–255 stays fixed, so brightness is comparable between frames.
      </p>
    </div>
  );
}
