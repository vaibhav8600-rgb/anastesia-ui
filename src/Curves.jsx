import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { device } from "./device.js";
import {
  unsupported, toSegments, toFlat, validateCurve as validate, parseCurveStatus as parseStatus,
} from "./protocol.js";

// Acceleration curves. The firmware stores each segment as eight integers
// scaled by 100, in the order start, END, cp1, cp2 — note that the end point
// comes before the control points.

export const DEFAULTS = {
  pointer: [0, 0, 116, 41, 10, 32, 16, 39, 116, 41, 4809, 100, 782, 41, 171, 100],
  scroll: [0, 0, 102, 100, 10, 38, 10, 100, 102, 100, 5702, 406, 2271, 89, 544, 355],
};

export default function Curves({ live, onNote }) {
  const [devices, setDevices] = useState([]);
  const [curves, setCurves] = useState({});
  const [name, setName] = useState(null);
  const [busy, setBusy] = useState(false);
  const [logX, setLogX] = useState(false);
  const [logY, setLogY] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [text, setText] = useState("");

  const load = useCallback(async () => {
    if (!live) {
      const seeded = Object.fromEntries(
        Object.entries(DEFAULTS).map(([k, v]) => [k, toSegments(v)]),
      );
      setDevices(Object.keys(DEFAULTS).map((n) => ({ name: n, maxCurves: 1, maxPoints: 8 })));
      setCurves(seeded);
      setName((n) => n ?? "pointer");
      return;
    }
    setBusy(true);
    try {
      const out = await device.send("curve status");
      if (unsupported(out)) { onNote("This firmware has no curve support."); setDevices([]); return; }
      const { devices: devs, data } = parseStatus(out);
      setDevices(devs);
      const next = {};
      for (const d of devs) {
        next[d.name] = toSegments(data[d.name]) ?? toSegments(DEFAULTS[d.name] ?? DEFAULTS.pointer);
      }
      setCurves(next);
      setName((n) => (n && next[n] ? n : devs[0]?.name ?? null));
      setDirty(false);
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(false);
    }
  }, [live, onNote]);

  useEffect(() => { load(); }, [load]);

  const segs = name ? curves[name] : null;
  // Each segment adds one point on top of the first; the device caps the total.
  const maxPoints = devices.find((d) => d.name === name)?.maxPoints ?? 8;

  const update = (next) => {
    setCurves((c) => ({ ...c, [name]: next }));
    setDirty(true);
  };

  const save = async () => {
    const err = validate(segs);
    if (err) { onNote(err); return; }
    const flat = toFlat(segs);
    if (!live) { onNote(`Demo mode — would send: curve set ${name} ${flat.join(" ")}`); setDirty(false); return; }
    setBusy(true);
    try {
      const res = await device.send(`curve set ${name} ${flat.join(" ")}`);
      if (/error|invalid/i.test(res)) throw new Error(`Device rejected the curve: ${res}`);
      onNote(`Saved the ${name} curve.`);
      setDirty(false);
    } catch (err2) {
      onNote(err2.message);
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!live) { onNote(`Demo mode — would send: curve destroy ${name}`); return; }
    setBusy(true);
    try {
      await device.send(`curve destroy ${name}`);
      onNote(`Removed the ${name} curve.`);
      await load();
    } catch (err) {
      onNote(err.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    const d = DEFAULTS[name] ?? DEFAULTS.pointer;
    update(toSegments(d));
  };

  const importText = () => {
    const nums = text.trim().split(/[\s,]+/).map(Number);
    if (!nums.length || nums.some(Number.isNaN)) { onNote("That is not a list of numbers."); return; }
    if (nums.length % 8) { onNote(`Need a multiple of 8 values, got ${nums.length}.`); return; }
    const next = toSegments(nums);
    const err = validate(next);
    if (err) { onNote(err); return; }
    update(next);
    setText("");
    onNote("Curve loaded into the editor. Save to write it to the device.");
  };

  if (!devices.length) {
    return (
      <>
        <p className="panel__blurb">Acceleration curves map how fast you move the ball to how far the pointer travels.</p>
        <p className="empty">{busy ? "Reading curves…" : "No curve-capable device reported."}</p>
        <button className="btn" onClick={load} disabled={busy}>Refresh</button>
      </>
    );
  }

  return (
    <>
      <p className="panel__blurb">
        Ball speed runs left to right; pointer multiplier runs bottom to top.
        Drag the round points to reshape it, and the small square handles to bend each span.
      </p>

      <div className="row row--wrap">
        {devices.map((d) => (
          <button
            key={d.name}
            className={"pill" + (d.name === name ? " is-active" : "")}
            onClick={() => setName(d.name)}
          >
            {d.name}
          </button>
        ))}
      </div>

      {segs && <CurveChart segs={segs} logX={logX} logY={logY} onChange={update} />}

      <div className="row row--wrap">
        <button className="pill" aria-pressed={logX} onClick={() => setLogX((v) => !v)}>X log scale</button>
        <button className="pill" aria-pressed={logY} onClick={() => setLogY((v) => !v)}>Y log scale</button>
      </div>

      <div className="row row--wrap">
        <button
          className="btn"
          onClick={() => update([...segs, extend(segs)])}
          disabled={segs.length + 1 >= maxPoints}
        >
          Add point
        </button>
        <button className="btn" onClick={() => update(segs.slice(0, -1))} disabled={segs.length <= 1}>
          Remove point
        </button>
        <button className="btn" onClick={reset}>Reset to default</button>
      </div>

      <div className="row row--wrap">
        <button className="btn btn--primary" onClick={save} disabled={busy || !dirty}>
          {dirty ? "Save curve" : "Saved"}
        </button>
        <button className="btn" onClick={load} disabled={busy}>Reload</button>
        <button className="btn btn--danger" onClick={destroy} disabled={busy}>Destroy</button>
      </div>

      <details className="sub">
        <summary>Share or paste a curve</summary>
        <p className="ctl__hint">Space-separated numbers, a multiple of eight.</p>
        <textarea
          className="search"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={toFlat(segs).join(" ")}
          aria-label="Curve datastring"
        />
        <div className="row row--wrap">
          <button className="btn" onClick={importText} disabled={!text.trim()}>Load into editor</button>
          <button
            className="btn"
            onClick={() => { setText(toFlat(segs).join(" ")); onNote("Current curve written into the box."); }}
          >
            Show current
          </button>
        </div>
      </details>
    </>
  );
}

/** A new segment continuing on from the last one. */
function extend(segs) {
  const last = segs[segs.length - 1];
  const dx = Math.max(10, last.end.x - last.start.x);
  const end = { x: last.end.x + dx, y: last.end.y + 0.5 };
  return {
    start: { ...last.end },
    end,
    cp1: { x: last.end.x + dx * 0.3, y: last.end.y + 0.1 },
    cp2: { x: last.end.x + dx * 0.7, y: end.y - 0.1 },
  };
}

function CurveChart({ segs, logX, logY, onChange }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const W = 100, H = 62, PAD = 8;

  const bounds = useMemo(() => {
    let maxX = 1, maxY = 1;
    for (const s of segs) {
      for (const p of [s.start, s.end, s.cp1, s.cp2]) {
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    return { maxX: maxX * 1.05, maxY: maxY * 1.15 };
  }, [segs]);

  const fwd = (v, max, log) => (log ? Math.log10(1 + Math.max(0, v)) / Math.log10(1 + max) : v / max);
  const inv = (n, max, log) => (log ? Math.pow(10, n * Math.log10(1 + max)) - 1 : n * max);

  const sx = (x) => PAD + fwd(x, bounds.maxX, logX) * (W - PAD * 2);
  const sy = (y) => H - PAD - fwd(y, bounds.maxY, logY) * (H - PAD * 2);

  const path = useMemo(() => {
    let d = "";
    for (const s of segs) {
      d += `M ${sx(s.start.x)} ${sy(s.start.y)} C ${sx(s.cp1.x)} ${sy(s.cp1.y)}, ${sx(s.cp2.x)} ${sy(s.cp2.y)}, ${sx(s.end.x)} ${sy(s.end.y)} `;
    }
    return d;
  }, [segs, bounds, logX, logY]);

  // Pointer drag in SVG user units, so touch and mouse behave identically.
  const toData = (e) => {
    const svg = svgRef.current;
    const r = svg.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * W;
    const ny = ((e.clientY - r.top) / r.height) * H;
    const fx = Math.min(1, Math.max(0, (nx - PAD) / (W - PAD * 2)));
    const fy = Math.min(1, Math.max(0, (H - PAD - ny) / (H - PAD * 2)));
    return { x: inv(fx, bounds.maxX, logX), y: inv(fy, bounds.maxY, logY) };
  };

  const onDown = (i, key) => (e) => {
    e.preventDefault();
    dragRef.current = { i, key };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toData(e);
    const next = segs.map((s) => ({
      start: { ...s.start }, end: { ...s.end }, cp1: { ...s.cp1 }, cp2: { ...s.cp2 },
    }));
    next[d.i][d.key] = { x: Math.max(0, p.x), y: Math.max(0, p.y) };
    // Segments share a joint: moving an end point drags the next start with it.
    if (d.key === "end" && next[d.i + 1]) next[d.i + 1].start = { ...next[d.i][d.key] };
    if (d.key === "start" && next[d.i - 1]) next[d.i - 1].end = { ...next[d.i][d.key] };
    onChange(next);
  };

  const onUp = () => { dragRef.current = null; };

  const handles = [];
  segs.forEach((s, i) => {
    if (i === 0) handles.push({ i, key: "start", p: s.start, kind: "node" });
    handles.push({ i, key: "cp1", p: s.cp1, kind: "ctrl" });
    handles.push({ i, key: "cp2", p: s.cp2, kind: "ctrl" });
    handles.push({ i, key: "end", p: s.end, kind: "node" });
  });

  return (
    <div className="chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Acceleration curve with ${segs.length} segment${segs.length > 1 ? "s" : ""}`}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line className="grid" x1={PAD} x2={W - PAD} y1={H - PAD - f * (H - PAD * 2)} y2={H - PAD - f * (H - PAD * 2)} />
            <line className="grid" y1={PAD} y2={H - PAD} x1={PAD + f * (W - PAD * 2)} x2={PAD + f * (W - PAD * 2)} />
          </g>
        ))}
        <text className="axis" x={PAD} y={H - 1.5}>0</text>
        <text className="axis" x={W - PAD} y={H - 1.5} textAnchor="end">{bounds.maxX.toFixed(0)}</text>
        <text className="axis" x={1.5} y={PAD + 2}>{bounds.maxY.toFixed(1)}x</text>

        {segs.map((s, i) => (
          <g key={i} className="tangent">
            <line x1={sx(s.start.x)} y1={sy(s.start.y)} x2={sx(s.cp1.x)} y2={sy(s.cp1.y)} />
            <line x1={sx(s.end.x)} y1={sy(s.end.y)} x2={sx(s.cp2.x)} y2={sy(s.cp2.y)} />
          </g>
        ))}

        <path className="curve" d={path} />

        {handles.map((h, k) => (
          <circle
            key={k}
            className={"handle handle--" + h.kind}
            cx={sx(h.p.x)}
            cy={sy(h.p.y)}
            r={h.kind === "node" ? 2.1 : 1.5}
            onPointerDown={onDown(h.i, h.key)}
          >
            <title>{`${h.key} ${h.p.x.toFixed(2)}, ${h.p.y.toFixed(2)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
