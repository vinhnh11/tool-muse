import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Ban, Check, ChevronDown, ChevronUp, Download, Eye, FileArchive, GitBranchPlus, LayoutGrid, Library, Loader2, RotateCcw, Search, Table2, X } from "lucide-react";
import { ACTIVE_JOB_STATUSES, api, JOB_STATUSES, TERMINAL_JOB_STATUSES, type Batch, type Job, type JobStatus } from "../../api";
import { JobStatusBadge, VersionBadge } from "../../components/Badge";
import { Button, IconButton } from "../../components/Button";
import { EmptyState, ErrorBanner } from "../../components/EmptyState";
import { Checkbox, Input } from "../../components/Field";
import { ProgressBar } from "../../components/ProgressBar";
import { FilterChip, Segmented } from "../../components/Tabs";
import { useApi, useDebounced, useLocalStorage, usePoll } from "../../hooks/useApi";
import { useRealtimeRefetch } from "../../hooks/useEvents";
import { JOB_STATUS_META, fmtCost, fmtSeconds, truncate } from "../../labels";
import { JobViewer, type ViewerTab } from "./JobViewer";
import { useJobActions } from "./useJobActions";

const PAGE = 500;

function ratioClass(r: string): string {
  if (r === "9:16" || r === "3:4") return "ratio-portrait";
  if (r === "1:1") return "ratio-square";
  return "ratio-landscape";
}

function JobThumb({ job, onOpen }: { job: Job; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  const m = JOB_STATUS_META[job.status];
  return (
    <button type="button" className={`thumb ${ratioClass(job.config.aspectRatio)}`} onClick={onOpen} aria-label={`Xem job #${job.seq}`}>
      {job.output?.thumbnail && !broken ? (
        <img src={job.output.thumbnail} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span className={`thumb-placeholder tone-${m.tone}`}>
          {ACTIVE_JOB_STATUSES.includes(job.status) ? <Loader2 size={18} className="spin" /> : job.status === "failed" ? <AlertTriangle size={18} /> : null}
          <span className="tiny">{m.label}</span>
        </span>
      )}
      {job.status === "completed" ? <span className="thumb-play" aria-hidden /> : null}
    </button>
  );
}

function JobError({ job }: { job: Job }) {
  const [open, setOpen] = useState(false);
  if (!job.error) return null;
  return (
    <div className="job-error">
      <span className="text-danger">{job.error.message ?? job.error.code}</span>
      {job.error.code || job.error.detail ? (
        <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
          {open ? "Ẩn" : "Chi tiết"} {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      ) : null}
      {open ? (
        <pre className="job-error-detail">
          {job.error.code ? `code: ${job.error.code}\n` : ""}
          {job.error.detail ?? ""}
        </pre>
      ) : null}
    </div>
  );
}

function JobProgress({ job }: { job: Job }) {
  if (job.status === "processing" || job.status === "submitting") return <ProgressBar value={job.status === "submitting" ? null : job.progress} size="sm" label={`Tiến độ job ${job.seq}`} />;
  return null;
}

export function JobsManager({ batch }: { batch: Batch }) {
  const [view, setView] = useLocalStorage<"table" | "grid">("bvs.jobs.view", "grid");
  const [filter, setFilter] = useState<JobStatus | "all">("all");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 350);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<{ id: string; tab: ViewerTab } | null>(null);
  const actions = useJobActions(batch.currency);

  useEffect(() => {
    setSelected(new Set());
    setOffset(0);
    setFilter("all");
    setQ("");
  }, [batch.id]);
  useEffect(() => setOffset(0), [filter, dq]);

  const jobs = useApi(() => api.jobs({ batchId: batch.id, status: filter === "all" ? undefined : [filter], q: dq || undefined, limit: PAGE, offset }), [batch.id, filter, dq, offset]);
  useRealtimeRefetch((ev) => ev.batchId === batch.id || (ev.type === "local.batch" && !ev.batchId), () => void jobs.reload(), 300);
  const hasActive = (jobs.data?.jobs ?? []).some((j) => !TERMINAL_JOB_STATUSES.includes(j.status) && j.status !== "awaiting_approval");
  usePoll(() => void jobs.reload(), 6000, hasActive);

  const list = useMemo(() => [...(jobs.data?.jobs ?? [])].sort((a, b) => a.seq - b.seq), [jobs.data]);
  const selJobs = list.filter((j) => selected.has(j.id));
  const selAssets = selJobs.filter((j) => j.output?.assetId).map((j) => j.output!.assetId);
  const allSelected = list.length > 0 && list.every((j) => selected.has(j.id));
  const total = jobs.data?.total ?? 0;

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const open = (job: Job, tab: ViewerTab = "info") => setViewer({ id: job.id, tab });

  const rowActions = (j: Job) => {
    const canCancel = !TERMINAL_JOB_STATUSES.includes(j.status) && !(j.status === "awaiting_approval" && batch.status === "awaiting_approval");
    const canRetry = j.status === "failed" || j.status === "cancelled";
    const canApprove = j.status === "awaiting_approval" && batch.status !== "awaiting_approval";
    return (
      <div className="row-actions">
        <IconButton label="Xem" icon={<Eye size={14} />} onClick={() => open(j)} />
        {j.output ? (
          <a className="btn btn-ghost btn-sm btn-icon-only" href={j.output.download} download title={j.kind === "image" ? "Tải ảnh" : "Tải video"} aria-label={j.kind === "image" ? "Tải ảnh" : "Tải video"}>
            <Download size={14} />
          </a>
        ) : null}
        {canApprove ? <IconButton label="Duyệt & chạy phiên bản này" icon={<Check size={14} />} onClick={() => actions.approveJobs([j])} /> : null}
        {canCancel ? <IconButton label="Hủy job" icon={<Ban size={14} />} loading={actions.busy === `cancel:${j.id}`} onClick={() => void actions.cancelJob(j)} /> : null}
        {canRetry ? <IconButton label="Tạo lại" icon={<RotateCcw size={14} />} onClick={() => void actions.retryJobs([j])} /> : null}
        {j.status === "completed" || j.status === "failed" ? <IconButton label={j.kind === "image" ? "Sửa prompt & tạo lại ảnh" : "Tạo phiên bản mới"} icon={<GitBranchPlus size={14} />} onClick={() => open(j, "regenerate")} /> : null}
      </div>
    );
  };

  return (
    <div className="jobs">
      <div className="toolbar jobs-toolbar">
        <div className="chip-row">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={batch.total}>
            Tất cả
          </FilterChip>
          {JOB_STATUSES.filter((s) => (batch.counts[s] ?? 0) > 0 || filter === s).map((s) => (
            <FilterChip key={s} active={filter === s} onClick={() => setFilter(s)} count={batch.counts[s] ?? 0} tone={JOB_STATUS_META[s].tone}>
              {JOB_STATUS_META[s].label}
            </FilterChip>
          ))}
        </div>
        <span className="spacer" />
        <div className="search">
          <Search size={14} aria-hidden />
          <Input className="input-sm" value={q} placeholder="Tìm theo prompt, tiêu đề, id" onChange={(e) => setQ(e.target.value)} aria-label="Tìm job" />
          {q ? <IconButton label="Xóa tìm kiếm" icon={<X size={12} />} onClick={() => setQ("")} /> : null}
        </div>
        <Segmented
          ariaLabel="Kiểu hiển thị"
          value={view}
          onChange={setView}
          options={[
            { id: "grid", label: <LayoutGrid size={14} aria-label="Lưới" />, title: "Dạng lưới" },
            { id: "table", label: <Table2 size={14} aria-label="Bảng" />, title: "Dạng bảng" },
          ]}
        />
      </div>

      <div className={`bulk-bar${selected.size ? " is-on" : ""}`}>
        <Checkbox ariaLabel="Chọn tất cả" checked={allSelected} indeterminate={!allSelected && selected.size > 0} onChange={(on) => setSelected(on ? new Set(list.map((j) => j.id)) : new Set())} label={selected.size ? `${selected.size} đã chọn` : "Chọn tất cả"} />
        {selected.size ? (
          <>
            <Button size="sm" icon={<Ban size={14} />} loading={actions.busy === "cancel:bulk"} onClick={() => void actions.cancelJobs(selJobs.filter((j) => !TERMINAL_JOB_STATUSES.includes(j.status)))}>
              Hủy đã chọn
            </Button>
            <Button size="sm" icon={<RotateCcw size={14} />} loading={actions.busy === "retry"} onClick={() => void actions.retryJobs(selJobs)}>
              Tạo lại đã chọn
            </Button>
            {selJobs.some((j) => j.status === "awaiting_approval") && batch.status !== "awaiting_approval" ? (
              <Button size="sm" icon={<Check size={14} />} onClick={() => actions.approveJobs(selJobs)}>
                Duyệt đã chọn
              </Button>
            ) : null}
            <Button size="sm" icon={<FileArchive size={14} />} loading={actions.busy === "zip"} disabled={!selAssets.length} onClick={() => void actions.downloadZip(selAssets, batch.name.replace(/[^\p{L}\p{N}_-]+/gu, "-"))}>
              Tải ZIP ({selAssets.length})
            </Button>
            <Button size="sm" icon={<Library size={14} />} disabled={!selAssets.length} onClick={() => void actions.addToLibrary(selAssets)}>
              Thêm vào Thư viện
            </Button>
            <IconButton label="Bỏ chọn" icon={<X size={14} />} onClick={() => setSelected(new Set())} />
          </>
        ) : (
          <span className="muted small">
            {jobs.refreshing ? <Loader2 size={12} className="spin" /> : null} {total} job{filter !== "all" || dq ? " khớp bộ lọc" : ""}
          </span>
        )}
      </div>

      {jobs.error ? <ErrorBanner error={jobs.error} onRetry={jobs.reload} /> : null}
      {jobs.loading ? <div className="skeleton" style={{ height: 200 }} /> : null}
      {jobs.data && !list.length ? <EmptyState compact title={filter !== "all" || dq ? "Không có job nào khớp bộ lọc" : "Batch chưa có job"} /> : null}

      {list.length && view === "grid" ? (
        <div className="job-grid">
          {list.map((j) => (
            <article key={j.id} className={`job-card status-${j.status}${selected.has(j.id) ? " is-selected" : ""}`}>
              <div className="job-card-media">
                <JobThumb job={j} onOpen={() => open(j)} />
                <div className="job-card-overlay">
                  <Checkbox ariaLabel={`Chọn job ${j.seq}`} checked={selected.has(j.id)} onChange={(on) => toggle(j.id, on)} />
                  <VersionBadge version={j.version} />
                </div>
              </div>
              <div className="job-card-body">
                <div className="job-card-row">
                  <span className="mono muted">#{j.seq}</span>
                  <JobStatusBadge status={j.status} />
                </div>
                <JobProgress job={j} />
                <div className="job-card-prompt" title={j.prompt}>
                  {j.title ? <strong>{truncate(j.title, 60)} · </strong> : null}
                  {truncate(j.prompt, 110)}
                </div>
                <div className="job-card-meta muted tiny">
                  {j.kind === "image" ? null : <span>{fmtSeconds(j.output?.durationSec ?? j.config.durationSec)}</span>}
                  <span>{j.config.aspectRatio}</span>
                  <span>
                    lần {j.attempt}/{j.maxAttempts}
                  </span>
                  {j.status === "processing" && j.progress !== null ? <span>{j.progress}%</span> : null}
                </div>
                <JobError job={j} />
                {rowActions(j)}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {list.length && view === "table" ? (
        <div className="table-wrap">
          <table className="table job-table">
            <thead>
              <tr>
                <th className="col-check" />
                <th className="col-thumb">Video</th>
                <th className="col-num">#</th>
                <th>Prompt</th>
                <th className="col-narrow">Model</th>
                <th className="col-narrow">Thời lượng</th>
                <th className="col-narrow">Trạng thái</th>
                <th className="col-narrow">Lần thử</th>
                <th className="col-narrow">Chi phí</th>
                <th className="col-actions">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {list.map((j) => (
                <tr key={j.id} className={selected.has(j.id) ? "is-selected" : undefined}>
                  <td className="col-check">
                    <Checkbox ariaLabel={`Chọn job ${j.seq}`} checked={selected.has(j.id)} onChange={(on) => toggle(j.id, on)} />
                  </td>
                  <td className="col-thumb">
                    <JobThumb job={j} onOpen={() => open(j)} />
                  </td>
                  <td className="col-num mono">
                    {j.seq} <VersionBadge version={j.version} />
                  </td>
                  <td className="col-prompt" data-label="Prompt">
                    {j.title ? <div className="strong">{j.title}</div> : null}
                    <div className="prompt-clamp" title={j.prompt}>
                      {j.prompt}
                    </div>
                    <JobError job={j} />
                  </td>
                  <td className="col-narrow small" data-label="Model" title={j.providerName ?? undefined}>
                    <code className="tiny">{j.modelId}</code>
                  </td>
                  <td className="col-narrow" data-label="Thời lượng">
                    {j.kind === "image" ? null : fmtSeconds(j.output?.durationSec ?? j.config.durationSec)}
                    <div className="muted tiny">{j.config.aspectRatio}</div>
                  </td>
                  <td className="col-narrow" data-label="Trạng thái">
                    <JobStatusBadge status={j.status} />
                    <JobProgress job={j} />
                    {j.nextAttemptAt ? <div className="muted tiny">thử lại lúc {new Date(j.nextAttemptAt).toLocaleTimeString("vi-VN")}</div> : null}
                  </td>
                  <td className="col-narrow mono" data-label="Lần thử">
                    {j.attempt}/{j.maxAttempts}
                  </td>
                  <td className="col-narrow small" data-label="Chi phí">
                    {j.actualCost !== null ? fmtCost(j.actualCost, batch.currency) : j.estimatedCost !== null ? <span className="muted">~{fmtCost(j.estimatedCost, batch.currency)}</span> : <span className="muted">-</span>}
                  </td>
                  <td className="col-actions">{rowActions(j)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {total > PAGE ? (
        <div className="pager">
          <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Trang trước
          </Button>
          <span className="muted small">
            {offset + 1}-{Math.min(total, offset + PAGE)} / {total}
          </span>
          <Button size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Trang sau
          </Button>
        </div>
      ) : null}

      {viewer ? <JobViewer jobId={viewer.id} initialTab={viewer.tab} batch={batch} onClose={() => setViewer(null)} onOpenJob={(id, tab) => setViewer({ id, tab: tab ?? "info" })} /> : null}
      {actions.dialog}
    </div>
  );
}
