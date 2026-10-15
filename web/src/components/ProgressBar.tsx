import type { Tone } from "../labels";

/** value null → thanh chạy vô định (provider không báo %) */
export function ProgressBar({ value, tone = "accent", size = "md", label }: { value: number | null; tone?: Tone; size?: "sm" | "md"; label?: string }) {
  const indeterminate = value === null || value === undefined || !Number.isFinite(value);
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div
      className={`progress progress-${size} tone-${tone}${indeterminate ? " is-indeterminate" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      aria-label={label ?? "Tiến độ"}
    >
      <div className="progress-fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** Thanh tiến độ nhiều đoạn theo trạng thái (batch) */
export function StackedProgress({ segments, total }: { segments: { value: number; tone: Tone; label: string }[]; total: number }) {
  return (
    <div className="stacked-progress" role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(", ")}>
      {total > 0
        ? segments
            .filter((s) => s.value > 0)
            .map((s) => <div key={s.label} className={`stacked-seg tone-${s.tone}`} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value}`} />)
        : null}
    </div>
  );
}
