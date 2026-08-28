import { useEffect, useId, useState } from "react";
import Dial from "./Dial.jsx";

// Three shapes, chosen by what the setting is actually like:
//   hero    -> a dial you turn, for the few settings people reach for
//   compact -> a number field, for the long tail where an exact value matters
//              more than sweeping (and where a stack of sliders is just noise)
//   default -> a slider, for the middle ground
// Toggles are always a switch. All of them are native inputs underneath.

export default function Control({ spec, value, onChange, disabled, compact }) {
  const id = useId();
  const hintId = spec.hint ? `${id}-hint` : undefined;

  if (spec.kind === "toggle") {
    const on = !!value;
    return (
      <div className={"ctl ctl--toggle" + (on ? " is-on" : "")}>
        <div className="ctl__head">
          <label className="ctl__label" htmlFor={id}>{spec.label}</label>
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={on}
            aria-describedby={hintId}
            className="switch"
            disabled={disabled}
            onClick={() => onChange(on ? 0 : 1)}
          >
            <span className="switch__dot" />
          </button>
        </div>
        {spec.hint && <p className="ctl__hint" id={hintId}>{spec.hint}</p>}
      </div>
    );
  }

  if (spec.hero) {
    return <Dial spec={spec} value={value} onChange={onChange} disabled={disabled} />;
  }

  if (compact) {
    return (
      <div className="ctl ctl--compact">
        <label className="ctl__label" htmlFor={id} title={spec.hint}>{spec.label}</label>
        <NumberField id={id} spec={spec} value={value} onChange={onChange} disabled={disabled} />
      </div>
    );
  }

  const v = value ?? spec.min;
  const pct = ((v - spec.min) / (spec.max - spec.min)) * 100;

  return (
    <div className="ctl">
      <div className="ctl__head">
        <label className="ctl__label" htmlFor={id}>{spec.label}</label>
        <span className="ctl__value">{format(v, spec)}</span>
      </div>
      <input
        id={id}
        className="range"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={v}
        disabled={disabled}
        aria-describedby={hintId}
        style={{ "--fill": pct + "%" }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {spec.hint && <p className="ctl__hint" id={hintId}>{spec.hint}</p>}
    </div>
  );
}

/** Typed edits commit on blur or Enter, so a half-typed number is not sent. */
function NumberField({ id, spec, value, onChange, disabled }) {
  const [text, setText] = useState(String(value ?? spec.min ?? 0));

  useEffect(() => { setText(String(value ?? spec.min ?? 0)); }, [value, spec.min]);

  const commit = () => {
    const n = Number(text);
    if (Number.isNaN(n)) { setText(String(value)); return; }
    const clamped = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <span className="numwrap">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={text}
        disabled={disabled}
        aria-label={spec.label}
        title={spec.hint}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {/* Always rendered, so a field with a unit and one without still share
          a right edge rather than sitting 31px apart. */}
      <span className="unit" aria-hidden={!spec.unit}>{spec.unit?.trim() ?? ""}</span>
    </span>
  );
}

function format(v, spec) {
  return v.toFixed(spec.step < 1 ? 1 : 0) + (spec.unit ?? "");
}
