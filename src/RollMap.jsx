import { useCallback, useEffect, useRef, useState } from "react";
import { onSurface, wantFastSurface, qualityBand } from "./Board.jsx";

// Tracking quality against how you are rolling the ball.
//
// WHY THIS IS NOT AN ABSOLUTE MAP OF THE BALL'S SURFACE
//
// To colour a patch of the ball you would have to know which patch is under
// the sensor, which means integrating rotation from a known origin and
// wrapping it at the ball's circumference. Neither is available here: the only
// motion we can observe is the pointer the ball is driving, and that has been
// through the firmware's sensitivity, its acceleration curve and then the
// operating system's own pointer acceleration — a nonlinear chain — while the
// circumference in pointer counts is unknown. Wrap at the wrong modulus and
// the same physical patch lands in a different cell every revolution, so the
// map smears into noise while still looking like a map. That is worse than not
// drawing one.
//
// Direction and speed survive that chain: the direction of travel is preserved
// by every stage, and speed is monotonic in it. So this bins quality by how
// the ball is moving rather than by where it has got to, which answers the
// questions people actually have — does tracking fall off when I roll fast,
// and is one direction worse than the others (a seated ball, a tilted sensor,
// a worn bearing).

const SECTORS = 12;                 // 30 degrees each
const RINGS = 3;                    // slow / medium / fast
const RING_EDGES = [40, 160];       // px/s boundaries between the three rings
const MIN_TRAVEL = 4;               // px in a window, below which it is not a roll

const R0 = 12;                      // inner hole, leaves room for the coverage figure
const R1 = 47;

const cellKey = (sector, ring) => sector * RINGS + ring;

/** Annular sector path, SVG. Angles in radians, screen coords. */
function wedge(cx, cy, r0, r1, a0, a1) {
  const pt = (r, a) => [(cx + r * Math.cos(a)).toFixed(2), (cy + r * Math.sin(a)).toFixed(2)];
  const [ax, ay] = pt(r0, a0);
  const [bx, by] = pt(r1, a0);
  const [cx2, cy2] = pt(r1, a1);
  const [dx, dy] = pt(r0, a1);
  return `M${ax},${ay} L${bx},${by} A${r1},${r1} 0 0 1 ${cx2},${cy2} L${dx},${dy} A${r0},${r0} 0 0 0 ${ax},${ay} Z`;
}

const ringOf = (speed) => (speed < RING_EDGES[0] ? 0 : speed < RING_EDGES[1] ? 1 : 2);

/** Screen angle -> sector, with 0 pointing up so the chart reads like a compass. */
const sectorOf = (dx, dy) => {
  const a = Math.atan2(dy, dx) + Math.PI / 2;          // 0 = up
  const turns = (a / (Math.PI * 2) + 1) % 1;
  return Math.floor(turns * SECTORS) % SECTORS;
};

export default function RollMap({ live }) {
  const [on, setOn] = useState(false);
  const [cells, setCells] = useState(() => new Map());   // "sensor:key" -> {sum,n}
  const [ids, setIds] = useState([]);
  const [scale, setScale] = useState(1000);

  // Motion accumulated since the last surface reading. Refs, not state: these
  // change on every pointer event and must not re-render anything.
  const motion = useRef({ dx: 0, dy: 0, dist: 0, since: 0 });

  const reset = useCallback(() => {
    setCells(new Map());
    setIds([]);
    motion.current = { dx: 0, dy: 0, dist: 0, since: performance.now() };
  }, []);

  useEffect(() => {
    if (!on) return undefined;
    motion.current = { dx: 0, dy: 0, dist: 0, since: performance.now() };

    // The trackball IS the pointer, so its motion is readable straight from the
    // page. Anything else you touch — a second mouse, a touchpad — lands in
    // here too, which is why the panel says to keep hands off them.
    const move = (e) => {
      const dx = e.movementX ?? 0;
      const dy = e.movementY ?? 0;
      motion.current.dx += dx;
      motion.current.dy += dy;
      motion.current.dist += Math.hypot(dx, dy);
    };
    window.addEventListener("pointermove", move, { passive: true });

    const releaseFast = live ? wantFastSurface() : () => {};

    const consume = (list) => {
      const m = motion.current;
      const now = performance.now();
      const secs = Math.max(0.05, (now - m.since) / 1000);
      motion.current = { dx: 0, dy: 0, dist: 0, since: now };

      // A still ball says nothing about how it rolls, so idle readings are not
      // folded in — they would drag every cell toward the resting value.
      if (m.dist < MIN_TRAVEL) return;

      const sector = sectorOf(m.dx, m.dy);
      const ring = ringOf(m.dist / secs);
      const key = cellKey(sector, ring);

      setCells((prev) => {
        const next = new Map(prev);
        for (const s of list) {
          if (s.max == null) continue;
          const id = `${s.sensor}:${key}`;
          const cur = next.get(id) ?? { sum: 0, n: 0 };
          next.set(id, { sum: cur.sum + s.quality, n: cur.n + 1 });
        }
        return next;
      });
      setScale(list.find((s) => s.max != null)?.max ?? 1000);
      setIds((prev) => {
        const seen = list.map((s) => s.sensor);
        return seen.every((n) => prev.includes(n)) ? prev : [...new Set([...prev, ...seen])].sort((a, b) => a - b);
      });
    };

    const off = onSurface(consume);
    return () => { window.removeEventListener("pointermove", move); off(); releaseFast(); };
  }, [on, live]);

  const filled = new Set([...cells.keys()].map((k) => k.split(":")[1]));
  const coverage = Math.round((filled.size / (SECTORS * RINGS)) * 100);

  return (
    <div className="knobs">
      <h3 className="sec">Roll quality {on && <span className="heat__live">SAMPLING</span>}</h3>
      <p className="panel__blurb">
        Tracking quality against how the ball is moving — direction around,
        speed outward. Start it, then roll the ball in every direction, slowly
        and quickly, until the dial fills.
      </p>

      <div className="row row--wrap">
        <button className="btn" onClick={() => setOn((v) => !v)}>
          {on ? "Stop" : "Start sampling"}
        </button>
        <button className="pill" onClick={reset} disabled={cells.size === 0}>Reset</button>
        <span className="ctl__hint">{coverage}% covered</span>
      </div>

      {on && (
        <p className="ctl__hint">
          Readings are attributed to whatever moved the pointer, so leave your
          other mouse alone while this runs.
        </p>
      )}

      <div className="heat__grid">
        {(ids.length ? ids : [null]).map((id) => (
          <div className="heat__cell" key={id ?? "empty"}>
            <div className="heat__head">
              <span className="gauges__name">{id === null ? "No readings yet" : `Sensor #${id}`}</span>
            </div>
            <Rose cells={cells} sensor={id} max={scale} />
          </div>
        ))}
      </div>

      <p className="ctl__hint">
        This is not a map of the ball's surface. Working out which patch is
        under the sensor needs the ball's circumference in pointer counts and a
        known starting orientation, and neither survives the firmware's
        acceleration or the operating system's. Direction and speed do survive,
        so those are what it plots.
      </p>
    </div>
  );
}

/** The polar chart: 12 directions around, 3 speed rings outward. */
function Rose({ cells, sensor, max }) {
  const step = (Math.PI * 2) / SECTORS;
  const ringStep = (R1 - R0) / RINGS;
  const wedges = [];

  for (let s = 0; s < SECTORS; s++) {
    for (let r = 0; r < RINGS; r++) {
      const cell = sensor === null ? undefined : cells.get(`${sensor}:${cellKey(s, r)}`);
      const mean = cell ? cell.sum / cell.n : null;
      // Sectors start at 12 o'clock and run clockwise, so subtract a quarter
      // turn from the screen angle.
      const a0 = s * step - Math.PI / 2;
      wedges.push(
        <path
          key={`${s}-${r}`}
          className={"rose__cell" + (mean === null ? " is-empty" : " rose__cell--" + qualityBand(mean, max))}
          d={wedge(50, 50, R0 + r * ringStep, R0 + (r + 1) * ringStep, a0, a0 + step)}
        >
          <title>
            {mean === null
              ? "Not sampled yet"
              : `${["slow", "medium", "fast"][r]}, ${Math.round(mean)}/${max} over ${cell.n} readings`}
          </title>
        </path>,
      );
    }
  }

  return (
    // The viewBox is bled out past the circle so the compass labels have room;
    // inside a tight 0-100 box they sat on top of the outer ring.
    <svg
      className="rose"
      viewBox="-14 -16 128 132"
      role="img"
      aria-label="Tracking quality by roll direction and speed"
    >
      {wedges}
      <text className="rose__tick" x="50" y="-6">up</text>
      <text className="rose__tick" x="50" y="110">down</text>
      <text className="rose__tick rose__tick--left" x="-12" y="52">left</text>
      <text className="rose__tick rose__tick--right" x="112" y="52">right</text>
    </svg>
  );
}
