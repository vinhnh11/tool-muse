import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Field({ label, hint, error, children, className, inline }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; inline?: boolean }) {
  return (
    <label className={`field${inline ? " field-inline" : ""}${className ? ` ${className}` : ""}`}>
      {label ? <span className="field-label">{label}</span> : null}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input${props.className ? ` ${props.className}` : ""}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input textarea${props.className ? ` ${props.className}` : ""}`} />;
}

export function Select({ options, placeholder, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string; disabled?: boolean }[]; placeholder?: string }) {
  return (
    <select {...props} className={`input select${props.className ? ` ${props.className}` : ""}`}>
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Công tắc bật/tắt */
export function Toggle({ checked, onChange, label, disabled, title, description }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; title?: string; description?: ReactNode }) {
  return (
    <label className={`toggle${disabled ? " is-disabled" : ""}`} title={title}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        <span>{label}</span>
        {description ? <span className="toggle-desc">{description}</span> : null}
      </span>
    </label>
  );
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; indeterminate?: boolean; ariaLabel?: string }) {
  return (
    <label className={`checkbox${disabled ? " is-disabled" : ""}`} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate);
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label ? <span>{label}</span> : null}
    </label>
  );
}
