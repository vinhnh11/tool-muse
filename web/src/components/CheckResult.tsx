import { AlertTriangle, CheckCircle2, CircleDollarSign, Copy, Gauge, Info, ListChecks, XCircle } from "lucide-react";
import type { BatchCheck, BatchEstimate } from "../api";
import { PRICING_LABEL, fmtCost, fmtNumber, truncate } from "../labels";
import { Badge } from "./Badge";

/** Kết quả kiểm prompt (BatchCheck) - lỗi theo số dòng */
export function CheckResultView({ check, limit = 80, unit = "video" }: { check: BatchCheck; limit?: number; unit?: string }) {
  const bad = check.items.filter((i) => i.issues.length > 0);
  return (
    <div className={`check-result ${check.ok ? "is-ok" : "is-bad"}`}>
      <div className="check-head">
        {check.ok ? <CheckCircle2 size={18} className="text-success" /> : <XCircle size={18} className="text-danger" />}
        <div className="check-summary">{check.summary}</div>
        <Badge tone={check.ok ? "success" : "danger"}>{check.ok ? "Hợp lệ - có thể tạo batch" : "Cần sửa trước khi tạo batch"}</Badge>
      </div>
      <div className="stat-row">
        <Stat label="Tổng dòng" value={check.totalLines} />
        <Stat label="Prompt hợp lệ" value={check.validPrompts} tone="success" />
        <Stat label="Không hợp lệ" value={check.invalidPrompts} tone={check.invalidPrompts ? "danger" : undefined} />
        <Stat label="Trùng" value={check.duplicateCount} tone={check.duplicateCount ? "warning" : undefined} />
        <Stat label="Dòng trống (bỏ qua)" value={check.blankLines.length} />
        <Stat label={`Số ${unit}`} value={check.jobCount} tone="accent" />
      </div>
      {check.batchIssues.length ? (
        <ul className="issue-list">
          {check.batchIssues.map((i, k) => (
            <li key={k} className="issue issue-danger">
              <AlertTriangle size={14} aria-hidden />
              <span>{i.message}</span>
              <code className="issue-code">{i.code}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {bad.length ? (
        <div className="issue-block">
          <div className="issue-block-title">
            <ListChecks size={14} aria-hidden /> Lỗi theo dòng ({bad.length})
          </div>
          <ul className="issue-list">
            {bad.slice(0, limit).map((it) => (
              <li key={it.index} className="issue">
                <span className="line-no">Dòng {it.line ?? it.index + 1}</span>
                <span className="issue-msgs">
                  {it.issues.map((x, k) => (
                    <span key={k} className="issue-msg">
                      {x.message}
                    </span>
                  ))}
                  <span className="issue-prompt muted">{truncate(it.prompt, 140)}</span>
                </span>
              </li>
            ))}
          </ul>
          {bad.length > limit ? <div className="muted small">… và {bad.length - limit} dòng khác.</div> : null}
        </div>
      ) : null}
      {check.nearDuplicates.length ? (
        <div className="issue-block">
          <div className="issue-block-title">
            <Copy size={14} aria-hidden /> Gần trùng (cảnh báo, vẫn tạo được)
          </div>
          <ul className="issue-list">
            {check.nearDuplicates.slice(0, 30).map((n, k) => (
              <li key={k} className="issue issue-warning">
                <span className="line-no">Dòng {n.line}</span>
                <span>
                  giống dòng {n.similarToLine} ({Math.round(n.score * 100)}%)
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" | "warning" | "accent" }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`}>
      <div className="stat-value">{fmtNumber(value)}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** Ước tính chi phí (BatchEstimate) - không bao giờ bịa giá */
export function EstimateView({ estimate }: { estimate: BatchEstimate }) {
  const known = estimate.total !== null;
  return (
    <div className="estimate">
      <div className="estimate-main">
        <CircleDollarSign size={20} className={known ? "text-accent" : "text-warning"} aria-hidden />
        <div>
          <div className="estimate-label">{estimate.imageCount !== undefined ? `Tạo ${fmtNumber(estimate.jobCount)} ảnh` : `Chi phí ước tính cho ${fmtNumber(estimate.jobCount)} video`}</div>
          <div className={`estimate-total${known ? "" : " is-unknown"}`}>{known ? fmtCost(estimate.total, estimate.currency) : "Không xác định"}</div>
          {estimate.basis ? <div className="muted small">{estimate.basis}</div> : null}
        </div>
        <Badge tone={estimate.kind === "free-mock" ? "warning" : estimate.kind === "unknown" ? "danger" : "info"}>{PRICING_LABEL[estimate.kind] ?? estimate.kind}</Badge>
      </div>
      <div className="estimate-grid">
        <div>
          <Gauge size={14} aria-hidden />
          <span>
            Chạy đồng thời thực tế: <strong>{estimate.effectiveConcurrency}</strong> luồng (provider cho phép tối đa {estimate.providerConcurrency})
          </span>
        </div>
        {estimate.budgetLimit !== null ? (
          <div>
            <Info size={14} aria-hidden />
            <span>
              Ngân sách: <strong>{fmtCost(estimate.budgetLimit, estimate.currency)}</strong> -{" "}
              {estimate.withinBudget === null ? (
                <span className="text-warning">không kiểm được (chưa có đơn giá)</span>
              ) : estimate.withinBudget ? (
                <span className="text-success">trong ngân sách</span>
              ) : (
                <span className="text-danger">VƯỢT ngân sách</span>
              )}
            </span>
          </div>
        ) : null}
      </div>
      {estimate.notes.length ? (
        <ul className="note-list">
          {estimate.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
