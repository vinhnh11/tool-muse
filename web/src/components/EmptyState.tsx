import type { ReactNode } from "react";
import { AlertTriangle, Loader2, RefreshCw, Settings } from "lucide-react";
import type { ApiError } from "../api";
import { isLlmError, isLlmNotConfigured } from "../labels";

export function EmptyState({ icon, title, description, action, compact }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty${compact ? " empty-compact" : ""}`}>
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <div className="empty-title">{title}</div>
      {description ? <div className="empty-desc">{description}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = "Đang tải...", inline }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? "loading-inline" : "loading"} role="status">
      <Loader2 className="spin" size={inline ? 14 : 18} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ rows = 3, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton-list" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

/** Hiển thị lỗi API: message tiếng Việt từ server + lối tắt tới Cài đặt khi lỗi LLM */
export function ErrorBanner({ error, onRetry, title, compact }: { error: ApiError | { code?: string; message: string } | null; onRetry?: () => void; title?: string; compact?: boolean }) {
  if (!error) return null;
  const code = "code" in error ? error.code : undefined;
  const llm = isLlmError(code);
  const notConfigured = isLlmNotConfigured(code);
  return (
    <div className={`banner ${notConfigured ? "banner-warning" : "banner-danger"}${compact ? " banner-compact" : ""}`} role="alert">
      <AlertTriangle size={16} className="banner-icon" aria-hidden />
      <div className="banner-body">
        {title || notConfigured ? <div className="banner-title">{notConfigured ? "Chưa cấu hình LLM" : title}</div> : null}
        <div>{error.message}</div>
        {code && !code.startsWith("HTTP_") && code !== "NETWORK" ? <div className="banner-code mono">{code}</div> : null}
      </div>
      <div className="banner-actions">
        {llm ? (
          <a className="btn btn-secondary btn-sm" href="#/settings">
            <Settings size={14} />
            <span className="btn-label">Mở Cài đặt LLM</span>
          </a>
        ) : null}
        {onRetry ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            <RefreshCw size={14} />
            <span className="btn-label">Thử lại</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Banner({ tone = "info", icon, title, children, actions }: { tone?: "info" | "warning" | "success" | "danger" | "neutral"; icon?: ReactNode; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`}>
      {icon ? <span className="banner-icon">{icon}</span> : null}
      <div className="banner-body">
        {title ? <div className="banner-title">{title}</div> : null}
        {children}
      </div>
      {actions ? <div className="banner-actions">{actions}</div> : null}
    </div>
  );
}
