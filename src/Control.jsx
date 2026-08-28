import { useId } from "react";

// One renderer for every knob in the catalogue. Native <input> underneath, so
// keyboard, touch and screen readers work without us reimplementing any of it.

export default function Control({ spec, value, onChange, disabled }) {
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

  const v = value ?? spec.min;
  const pct = ((v - spec.min) / (spec.max - spec.min)) * 100;

  return (
    <div className="ctl">
      <div className="ctl__head">
        <label className="ctl__label" htmlFor={id}>{spec.label}</label>
        <output className="ctl__value" htmlFor={id}>
          {formatValue(v, spec)}
        </output>
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

function formatValue(v, spec) {
  const decimals = spec.step < 1 ? 1 : 0;
  return v.toFixed(decimals) + (spec.unit ?? "");
}
