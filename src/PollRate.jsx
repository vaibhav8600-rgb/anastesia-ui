import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

// Report rate as the page sees it. `pointerrawupdate` fires once per HID report
// the OS hands over, not once per frame like `pointermove`, so counting them
// over time is the poll rate. Browsers without it fall back to pointermove's
// coalesced events, which carry the same per-report timestamps.
//
// A gap longer than IDLE_GAP is the pointer at rest, not a slow poll, so it is
// left out of the time base — otherwise every pause drags the figure down.
// Rate is reports / time-moving, which stays honest when timestamps are
// coarsened to 0.1ms and a single 8kHz interval cannot be resolved.

const IDLE_GAP = 50;     // ms
const HISTORY = 30;      // points on the chart
const SPEEDS = { Fast: 100, Normal: 250, Slow: 1000 };   // ms per point
const RAW = typeof window !== "undefined" && "onpointerrawupdate" in window;

export default function PollRate() {
  const [speed, setSpeed] = useState("Normal");
  const [run, setRun] = useState(0);          // bumped by Reset
  const [r, setR] = useState({ hz: null, avg: null, peak: 0, hist: [], at: 0 });

  useEffect(() => {
    let last = 0, n = 0, t = 0, allN = 0, allT = 0, peak = 0;
    const hist = [];
    setR({ hz: null, avg: null, peak: 0, hist: [], at: 0 });

    const take = (ts) => {
      const dt = ts - last;
      last = ts;
      if (dt < IDLE_GAP) { n++; t += dt; }
    };
    const onEvent = (e) => {
      const list = e.getCoalescedEvents?.();
      if (list?.length) for (const c of list) take(c.timeStamp);
      else take(e.timeStamp);
    };
    const type = RAW ? "pointerrawupdate" : "pointermove";
    window.addEventListener(type, onEvent, { passive: true });

    const id = setInterval(() => {
      // Under a handful of reports there is no rate to speak of, only a nudge.
      const hz = n >= 4 && t > 0 ? Math.round((n / t) * 1000) : null;
      allN += n; allT += t; n = 0; t = 0;
      // At rest there is no current rate. Left as it was, the last reading sat
      // under "Current" indefinitely, as if the mouse were still reporting it.
      if (hz === null) { setR((p) => (p.hz === null ? p : { ...p, hz: null })); return; }
      peak = Math.max(peak, hz);
      hist.push(hz);
      // One more than fits: the oldest scrolls out past the left edge.
      if (hist.length > HISTORY + 1) hist.shift();
      setR({ hz, avg: Math.round((allN / allT) * 1000), peak, hist: [...hist], at: performance.now() });
    }, SPEEDS[speed]);

    return () => { window.removeEventListener(type, onEvent); clearInterval(id); };
  }, [speed, run]);

  const hz = (v) => (v ? `${v} Hz` : "—");

  return (
    <div className="poll">
      <section className="knobs poll__stats">
        <h3 className="sec">Statistics</h3>
        <dl className="poll__list">
          <dt>Current</dt><dd className="poll__now">{hz(r.hz)}</dd>
          <dt>Average</dt><dd>{hz(r.avg)}</dd>
          <dt>Maximum</dt><dd>{hz(r.peak)}</dd>
        </dl>

        <div className="poll__foot">
          <div className="row" role="group" aria-label="Update speed">
            {Object.keys(SPEEDS).map((k) => (
              <button key={k} className="pill" aria-pressed={speed === k} onClick={() => setSpeed(k)}>{k}</button>
            ))}
          </div>
          <p className="ctl__hint">
            Move your pointer continuously to measure the polling rate. Slow
            movement sends fewer reports than the link allows.
            {!RAW && " This browser has no raw pointer events, so use a Chromium browser for rates above your screen's refresh rate."}
          </p>
          <button className="btn btn--danger" onClick={() => setRun((v) => v + 1)}>Reset</button>
        </div>
      </section>

      <section className="knobs poll__chart">
        <Chart values={r.hist} at={r.at} interval={SPEEDS[speed]} />
      </section>
    </div>
  );
}

/** Round an axis step up to 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return p * ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw));
}

const L = 48, R = 12, T = 12, B = 24;     // plot margins, px

function Chart({ values, at, interval }) {
  // Drawn at the box's real pixel size rather than a fixed viewBox scaled to
  // fit: scaled, the axis labels shrank to ~6px on a phone. The box fills its
  // card, so the chart takes the card's height too instead of floating in it.
  const box = useRef(null);
  const [{ W, H }, setSize] = useState({ W: 600, H: 300 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({
      W: Math.max(240, Math.round(e.contentRect.width)),
      H: Math.max(180, Math.round(e.contentRect.height)),
    }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const hi = Math.max(50, ...values);
  const step = niceStep(hi / 6);
  const top = Math.ceil(hi / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const dx = (W - L - R) / (HISTORY - 1);
  // Newest point on the right edge, the rest one step apart to its left.
  const x = (i) => W - R - (values.length - 1 - i) * dx;
  const y = (v) => H - B - (v / top) * (H - T - B);
  const pts = values.map((v, i) => [x(i), y(v)]);

  // Catmull-Rom through the points, as cubic Béziers. Control points are held
  // inside the plot so a dip to a low reading never curves below zero.
  const clamp = (v) => Math.min(H - B, Math.max(T, v));
  let d = pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
  for (let i = 1; i < pts.length; i++) {
    const [p0, p1, p2, p3] = [pts[i - 2] ?? pts[i - 1], pts[i - 1], pts[i], pts[i + 1] ?? pts[i]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clamp(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clamp(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }

  // Readings arrive in steps, so drawn as-is the line jumps once per reading.
  // Between readings it slides left by the fraction of a step that has
  // elapsed; the next reading re-indexes every point one step left at the same
  // moment the slide resets, so the motion never breaks. Written straight to
  // the element each frame — no React render. Layout effect, so the reset
  // lands before the browser paints the new path, not one frame after it.
  const g = useRef(null);
  const clip = useId();
  useLayoutEffect(() => {
    let raf;
    const frame = () => {
      const frac = at ? Math.min(1, (performance.now() - at) / interval) : 0;
      g.current?.setAttribute("transform", `translate(${(-frac * dx).toFixed(2)},0)`);
      // A full step is as far as it goes until the next reading, so stop there
      // rather than rewriting the same transform 60 times a second at rest.
      if (frac < 1 && at) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [at, interval, dx]);

  return (
    <div className="poll__box" ref={box}>
    <svg className="poll__svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={values.length ? `Polling rate, last ${values.length} readings` : "No readings yet"}>
      {ticks.map((v) => (
        <g key={v}>
          <line className="poll__grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text className="poll__tick" x={L - 8} y={y(v)}>{v}</text>
        </g>
      ))}
      {Array.from({ length: HISTORY }, (_, i) => (
        <line key={i} className="poll__grid" x1={L + i * dx} x2={L + i * dx} y1={T} y2={H - B} />
      ))}
      <clipPath id={clip}><rect x={L} y={0} width={W - L - R + 4} height={H - B + 4} /></clipPath>
      <g clipPath={`url(#${clip})`}>
        <g ref={g}>
          <path className="poll__line" d={d} />
          {pts.map(([px, py], i) => <circle key={i} className="poll__dot" cx={px} cy={py} r="3" />)}
        </g>
      </g>
      {!values.length && <text className="poll__empty" x={(W + L) / 2} y={H / 2}>Move your pointer</text>}
    </svg>
    </div>
  );
}
