import type { ReactNode } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number | null;
  disabled?: boolean;
}

export function Tabs<T extends string>({ items, value, onChange, size = "md", className }: { items: TabItem<T>[]; value: T; onChange: (v: T) => void; size?: "sm" | "md"; className?: string }) {
  return (
    <div className={`tabs tabs-${size}${className ? ` ${className}` : ""}`} role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          className={`tab${t.id === value ? " is-active" : ""}`}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
        >
          {t.icon}
          <span>{t.label}</span>
          {t.count !== undefined && t.count !== null ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Nhóm nút chọn một (segmented control) */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: { options: { id: T; label: ReactNode; title?: string; disabled?: boolean }[]; value: T; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          title={o.title}
          disabled={o.disabled}
          className={`segmented-item${o.id === value ? " is-active" : ""}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Chip lọc có đếm */
export function FilterChip({ active, onClick, children, count, tone }: { active: boolean; onClick: () => void; children: ReactNode; count?: number; tone?: string }) {
  return (
    <button type="button" className={`chip${active ? " is-active" : ""}${tone ? ` chip-${tone}` : ""}`} onClick={onClick} aria-pressed={active}>
      {children}
      {count !== undefined ? <span className="chip-count">{count}</span> : null}
    </button>
  );
}
