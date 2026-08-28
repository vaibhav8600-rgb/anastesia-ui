import { useId, useRef } from "react";

// A radial knob for the handful of settings people actually reach for.
// Sliders are fine for a long tail of parameters, but a wall of them reads as
// a spreadsheet; these read as controls you turn.

const ARC = 270;                 // degrees swept, leaving a gap at the bottom
const START = 135;               // ...starting here, so the gap is centred
const R = 42;
const CIRC = 2 * Math.PI * R;

const polar = (deg, r = R) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: 50 + r * Math.cos(rad), y: 50 + r * Math.sin(rad) };
};

export default function Dial({ spec, value, onChange, disabled }) {
  const id = useId();
  const drag = useRef(null);
  const min = spec.min ?? 0;
  const max = spec.max ?? 100;
  const step = spec.step ?? 1;
  const v = value ?? min;
  const frac = Math.min(1, Math.max(0, (v - min) / (max - min)));

  const clamp = (n) => {
    const snapped = Math.round(n / step) * step;
    // step can be fractional (0.1), so trim the float noise it introduces
    const fixed = Number(snapped.toFixed(4));
    return Math.min(max, Math.max(min, fixed));
  };

  // Vertical drag, not rotation: it is far easier to be precise with, and it
  // works the same on a phone where your thumb covers the dial.
  const onPointerDown = (e) => {
    if (disabled) return;
    drag.current = { y: e.clientY, from: v };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dy = drag.current.y - e.clientY;
    const perPixel = (max - min) / 180;      // a 180px pull covers the range
    onChange(clamp(drag.current.from + dy * perPixel));
  };
  const onPointerUp = (e) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e) => {
    const big = (max - min) / 10;
    const map = {
      ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step,
      PageUp: big, PageDown: -big,
    };
    if (e.key === "Home") { e.preventDefault(); onChange(min); return; }
    if (e.key === "End") { e.preventDefault(); onChange(max); return; }
    if (!(e.key in map)) return;
    e.preventDefault();
    onChange(clamp(v + map[e.key]));
  };

  const end = polar(START + ARC * frac);
  const decimals = step < 1 ? 1 : 0;

  return (
    <div className={"dial" + (disabled ? " is-disabled" : "")}>
      <svg
        viewBox="0 0 100 100"
        className="dial__face"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={id}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={v}
        aria-valuetext={`${v.toFixed(decimals)}${spec.unit ?? ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <circle
          className="dial__track"
          cx="50" cy="50" r={R}
          strokeDasharray={`${(CIRC * ARC) / 360} ${CIRC}`}
          transform={`rotate(${START - 90} 50 50)`}
        />
        <circle
          className="dial__value"
          cx="50" cy="50" r={R}
          strokeDasharray={`${(CIRC * ARC * frac) / 360} ${CIRC}`}
          transform={`rotate(${START - 90} 50 50)`}
        />
        <circle className="dial__knob" cx={end.x} cy={end.y} r="5" />
        <text className="dial__num" x="50" y="52">{v.toFixed(decimals)}</text>
        {spec.unit && <text className="dial__unit" x="50" y="66">{spec.unit.trim()}</text>}
      </svg>
      <span className="dial__label" id={id}>{spec.label}</span>
    </div>
  );
}
