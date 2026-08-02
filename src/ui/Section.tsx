import { useState, type ReactNode } from 'react';

/** A collapsible titled block. The panels are built entirely from these. */
export function Section({
  title,
  children,
  defaultOpen = true,
  aside,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  aside?: ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="section">
      <div
        className="section-head"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span>
          {open ? '▾' : '▸'} {title}
        </span>
        {aside}
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

/** A labelled numeric input that commits on change and tolerates empty text. */
export function NumberField({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
  suffix,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div>
      <label>
        {label}
        {suffix ? <span className="faint"> {suffix}</span> : null}
      </label>
      <input
        type="number"
        value={Number.isFinite(value) ? Number(value.toFixed(4)) : 0}
        step={step}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        disabled={disabled ?? false}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </div>
  );
}

/** A slider with a live numeric readout. */
export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
}): React.ReactElement {
  return (
    <div>
      <label>
        {label} <span className="mono faint">{format ? format(value) : value.toFixed(1)}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.ReactElement {
  return (
    <div className="inline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label>{label}</label>
    </div>
  );
}

export function ProvenanceBadge({
  provenance,
}: {
  provenance: 'measured' | 'published' | 'estimated';
}): React.ReactElement {
  const text =
    provenance === 'measured' ? 'measured' : provenance === 'published' ? 'published' : 'estimated';
  return <span className={`badge ${provenance}`}>{text}</span>;
}
