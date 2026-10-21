import type { ReactNode } from "react";
import type { BatchStatus, JobStatus } from "../api";
import { APPROVAL_META, BATCH_STATUS_META, JOB_STATUS_META, PROVIDER_STATUS_META, type Tone } from "../labels";

export function Badge({ tone = "neutral", children, dot, title, className }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string; className?: string }) {
  return (
    <span className={`badge tone-${tone}${className ? ` ${className}` : ""}`} title={title}>
      {dot ? <span className="badge-dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const m = JOB_STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  const live = status === "processing" || status === "submitting";
  return (
    <Badge tone={m.tone} dot className={live ? "badge-live" : undefined}>
      {m.label}
    </Badge>
  );
}

export function BatchStatusBadge({ status }: { status: BatchStatus }) {
  const m = BATCH_STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge tone={m.tone} dot className={status === "running" ? "badge-live" : undefined}>
      {m.label}
    </Badge>
  );
}

export function ApprovalBadge({ approval }: { approval: keyof typeof APPROVAL_META }) {
  const m = APPROVAL_META[approval] ?? APPROVAL_META.pending;
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function ProviderStatusBadge({ status }: { status: string }) {
  const m = PROVIDER_STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge tone={m.tone} dot>
      {m.label}
    </Badge>
  );
}

export function VersionBadge({ version }: { version: number | null | undefined }) {
  if (!version) return null;
  return (
    <span className="version-badge" title={`Phiên bản ${version}`}>
      V{version}
    </span>
  );
}

export function MockBadge() {
  return (
    <Badge tone="warning" title="Provider Mock tạo video kiểm thử bằng FFmpeg">
      Mock - video kiểm thử, không phải video AI, không tính phí
    </Badge>
  );
}
