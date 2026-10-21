import { useEffect, useState } from "react";
import { Ban, Download, FolderKanban, Pause, Play, PlayCircle, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { api, exportUrls, JOB_STATUSES, PENDING_JOB_STATUSES, type Batch } from "../../api";
import { BatchStatusBadge, MockBadge } from "../../components/Badge";
import { Button, LinkButton } from "../../components/Button";
import { useDialogs } from "../../components/ConfirmDialog";
import { EmptyState, ErrorBanner } from "../../components/EmptyState";
import { ProgressBar, StackedProgress } from "../../components/ProgressBar";
import { Segmented } from "../../components/Tabs";
import { toastApiError, useToast } from "../../components/Toast";
import { useApi, useLocalStorage, usePoll } from "../../hooks/useApi";
import { emitLocal, useRealtimeRefetch } from "../../hooks/useEvents";
import { JOB_STATUS_META, MODE_LABEL, fmtCost, fmtRelative, fmtSeconds } from "../../labels";
import { useStudio } from "../../state/studio";
import { JobsManager } from "./JobsManager";
import { useJobActions } from "./useJobActions";

function BatchHeader({ batch, reload, onDeleted }: { batch: Batch; reload: () => void; onDeleted: () => void }) {
  const { openApproval } = useStudio();
  const toast = useToast();
  const dialogs = useDialogs();
  const actions = useJobActions(batch.currency);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = PENDING_JOB_STATUSES.filter((s) => s !== "awaiting_approval" || batch.status !== "awaiting_approval").reduce((n, s) => n + (batch.counts[s] ?? 0), 0);
  const failed = batch.counts.failed ?? 0;
  const awaitingJobs = batch.counts.awaiting_approval ?? 0;
  const done = (batch.counts.completed ?? 0) + failed + (batch.counts.cancelled ?? 0);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      emitLocal({ type: "local.batch", batchId: batch.id });
      reload();
    } catch (e) {
      toastApiError(toast, "Thao tác thất bại", e);
    } finally {
      setBusy(null);
    }
  };

  const cancelPending = async () => {
    if (!(await dialogs.confirm({ title: "Hủy các job chưa chạy?", body: `${pending} job đang chờ/xếp hàng sẽ bị hủy (chưa gửi provider nên không tốn phí). Job đang chạy không bị ảnh hưởng.`, confirmLabel: "Hủy job chưa chạy", danger: true }))) return;
    setBusy("cancel");
    try {
      const r = await api.cancelPending(batch.id);
      toast.success(`Đã hủy ${r.cancelled} job chưa chạy`);
      reload();
    } catch (e) {
      toastApiError(toast, "Không hủy được", e);
    } finally {
      setBusy(null);
    }
  };

  const segments = JOB_STATUSES.map((s) => ({ value: batch.counts[s] ?? 0, tone: JOB_STATUS_META[s].tone, label: JOB_STATUS_META[s].label }));

  return (
    <div className="batch-header">
      <div className="batch-header-top">
        <div className="batch-title-block">
          <div className="batch-title-row">
            <h3 className="batch-title">{batch.name}</h3>
            <BatchStatusBadge status={batch.status} />
            {batch.providerType === "mock" ? <MockBadge /> : null}
          </div>
          <div className="muted small">
            {batch.providerName ?? batch.providerConfigId} · <code>{batch.modelId}</code> · {MODE_LABEL[batch.config.mode]} · {fmtSeconds(batch.config.durationSec)} · {batch.config.aspectRatio} · {batch.config.resolution}
            {batch.config.audio ? " · âm thanh" : ""} · tạo {fmtRelative(batch.createdAt)}
          </div>
        </div>
        <div className="batch-actions">
          {batch.status === "awaiting_approval" && awaitingJobs > 0 ? (
            <Button variant="primary" icon={<PlayCircle size={16} />} onClick={() => openApproval(batch.id, batch.estimate)}>
              Duyệt & chạy
            </Button>
          ) : null}
          {batch.status === "running" ? (
            <Button icon={<Pause size={15} />} loading={busy === "pause"} onClick={() => void act("pause", () => api.pauseBatch(batch.id), "Đã tạm dừng - không gửi job mới")}>
              Tạm dừng
            </Button>
          ) : null}
          {batch.status === "paused" ? (
            <Button variant="primary" icon={<Play size={15} />} loading={busy === "resume"} onClick={() => void act("resume", () => api.resumeBatch(batch.id), "Đã tiếp tục batch")}>
              Tiếp tục
            </Button>
          ) : null}
          {pending > 0 && batch.status !== "awaiting_approval" ? (
            <Button icon={<Ban size={15} />} loading={busy === "cancel"} onClick={() => void cancelPending()}>
              Hủy các job chưa chạy
            </Button>
          ) : null}
          {batch.status === "awaiting_approval" && awaitingJobs > 0 ? (
            <Button icon={<Ban size={15} />} loading={busy === "cancel"} onClick={() => void cancelPending()}>
              Hủy batch
            </Button>
          ) : null}
          {failed > 0 ? (
            <Button icon={<RotateCcw size={15} />} loading={actions.busy === "retry"} onClick={() => void actions.retryFailed(batch)}>
              Tạo lại job lỗi ({failed})
            </Button>
          ) : null}
          {(batch.counts.completed ?? 0) > 0 ? (
            <Button
              icon={<Trash2 size={15} />}
              loading={actions.busy === "delete"}
              title="Xóa batch nhưng giữ video trong Thư viện"
              onClick={() => void actions.deleteBatch(batch, true).then((ok) => ok && onDeleted())}
            >
              Xóa batch (giữ video)
            </Button>
          ) : null}
          <Button
            variant="danger"
            icon={<Trash2 size={15} />}
            loading={actions.busy === "delete"}
            title="Xóa batch, job và mọi video đã tạo"
            onClick={() => void actions.deleteBatch(batch, false).then((ok) => ok && onDeleted())}
          >
            Xóa batch + video
          </Button>
        </div>
      </div>

      {batch.status === "awaiting_approval" && awaitingJobs === 0 ? <div className="banner banner-neutral">Batch không còn job nào chờ duyệt (đã hủy hết) - không cần chạy.</div> : null}
      <div className="batch-progress">
        <StackedProgress segments={segments} total={batch.total} />
        <div className="batch-progress-text">
          <strong>{batch.progress}%</strong>
          <span className="muted">
            {done}/{batch.total} job đã kết thúc · {batch.counts.completed ?? 0} video xong
          </span>
        </div>
      </div>

      <div className="batch-stats">
        <div className="count-chips">
          {JOB_STATUSES.filter((s) => (batch.counts[s] ?? 0) > 0).map((s) => (
            <span key={s} className={`count-chip tone-${JOB_STATUS_META[s].tone}`}>
              <span className="badge-dot" aria-hidden />
              {JOB_STATUS_META[s].label}: <strong>{batch.counts[s]}</strong>
            </span>
          ))}
        </div>
        <div className="cost-row">
          <span title="Ước tính trước khi chạy, theo đơn giá đã nhập">
            Chi phí <em>ước tính</em>: <strong>{fmtCost(batch.estimatedCost, batch.currency)}</strong>
          </span>
          <span title="Chi phí thực tế provider báo về (job đã xong)">
            Chi phí <em>thực tế</em>: <strong>{batch.actualCost === null ? "chưa có" : fmtCost(batch.actualCost, batch.currency)}</strong>
          </span>
          {batch.committedCost ? (
            <span title="Thực tế (nếu có) hoặc ước tính của job đã gửi/đang chạy/xong">
              Đã cam kết: <strong>{fmtCost(batch.committedCost, batch.currency)}</strong>
            </span>
          ) : null}
          {batch.budgetLimit !== null ? (
            <span>
              Ngân sách: <strong>{fmtCost(batch.budgetLimit, batch.currency)}</strong>
            </span>
          ) : null}
          <span>
            Luồng:{" "}
            <select
              aria-label="Số luồng của batch"
              value={String(batch.maxConcurrency)}
              disabled={busy !== null}
              onChange={(e) => void act("conc", () => api.setBatchConcurrency(batch.id, Number(e.target.value)), `Đã đổi sang ${e.target.value} luồng`)}
            >
              {[...new Set([1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, batch.maxConcurrency])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {batch.estimate && batch.estimate.effectiveConcurrency < batch.maxConcurrency ? <span className="muted"> (chọn {batch.maxConcurrency}, provider giới hạn)</span> : null}
          </span>
        </div>
      </div>

      <div className="export-row">
        <span className="muted small">Xuất:</span>
        <LinkButton size="sm" href={exportUrls.batch(batch.id, "zip")} icon={<Download size={14} />} title="ZIP mọi video đã xong + manifest + prompt">
          ZIP
        </LinkButton>
        <LinkButton size="sm" href={exportUrls.batch(batch.id, "csv")}>
          CSV
        </LinkButton>
        <LinkButton size="sm" href={exportUrls.batch(batch.id, "json")}>
          JSON
        </LinkButton>
        <LinkButton size="sm" href={exportUrls.batch(batch.id, "txt")}>
          TXT
        </LinkButton>
      </div>
      {actions.dialog}
    </div>
  );
}

function BatchListItem({ b, active, onClick }: { b: Batch; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`batch-item${active ? " is-active" : ""}`} onClick={onClick} aria-current={active || undefined}>
      <div className="batch-item-top">
        <span className="batch-item-name">{b.name}</span>
        <BatchStatusBadge status={b.status} />
      </div>
      <ProgressBar value={b.progress} size="sm" tone={b.status === "completed" ? "success" : b.status === "paused" ? "warning" : "accent"} />
      <div className="batch-item-meta muted tiny">
        <span>
          {b.counts.completed ?? 0}/{b.total} video
        </span>
        {b.counts.failed ? <span className="text-danger">{b.counts.failed} lỗi</span> : null}
        <span>{b.modelId}</span>
        <span>{fmtRelative(b.createdAt)}</span>
      </div>
    </button>
  );
}

export function BatchesSection() {
  const { sessionId, selectedBatchId, setSelectedBatchId } = useStudio();
  const [scope, setScope] = useLocalStorage<"session" | "all">("bvs.batch.scope", "session");
  const filterSession = scope === "session" ? sessionId : null;
  const list = useApi(() => api.batches(filterSession).then((r) => r.batches), [filterSession]);
  const selected = useApi(() => (selectedBatchId ? api.batch(selectedBatchId) : Promise.resolve(null)), [selectedBatchId]);

  useRealtimeRefetch((ev) => ev.type.startsWith("batch.") || ev.type === "local.batch" || (ev.type === "job.status" && ev.batchId !== selectedBatchId), () => void list.reload(), 500);
  useRealtimeRefetch((ev) => Boolean(selectedBatchId) && (ev.batchId === selectedBatchId || ev.type === "local.batch"), () => void selected.reload(), 300);
  usePoll(() => void selected.reload(), 8000, selected.data?.status === "running");

  // Tự chọn batch mới nhất nếu chưa chọn / batch cũ không còn
  useEffect(() => {
    if (!list.data) return;
    if (!selectedBatchId && list.data[0]) setSelectedBatchId(list.data[0].id);
  }, [list.data, selectedBatchId, setSelectedBatchId]);
  useEffect(() => {
    if (selected.error?.status === 404) setSelectedBatchId(list.data?.[0]?.id ?? null);
  }, [selected.error, list.data, setSelectedBatchId]);

  return (
    <section className="card batches-card">
      <div className="card-head">
        <div className="card-title">
          <FolderKanban size={16} aria-hidden /> Batch & video
        </div>
        <div className="card-head-actions">
          <Segmented
            ariaLabel="Phạm vi"
            value={scope}
            onChange={setScope}
            options={[
              { id: "session", label: "Phiên này", disabled: !sessionId },
              { id: "all", label: "Tất cả" },
            ]}
          />
          <Button size="sm" variant="ghost" icon={<RefreshCw size={14} className={list.refreshing ? "spin" : undefined} />} onClick={() => void list.reload()} aria-label="Tải lại" title="Tải lại" />
        </div>
      </div>
      {list.error ? <ErrorBanner error={list.error} onRetry={list.reload} /> : null}
      {list.loading ? <div className="skeleton" style={{ height: 90 }} /> : null}
      {list.data && !list.data.length ? (
        <EmptyState
          compact
          icon={<FolderKanban size={22} />}
          title={scope === "session" ? "Phiên này chưa có batch nào" : "Chưa có batch nào"}
          description="Nhập prompt ở Khu vực tạo, kiểm tra rồi bấm “Tạo batch”."
          action={
            scope === "session" ? (
              <Button size="sm" onClick={() => setScope("all")}>
                Xem batch của mọi phiên
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {list.data?.length ? (
        <div className="batch-list" role="list">
          {list.data.map((b) => (
            <BatchListItem key={b.id} b={b} active={b.id === selectedBatchId} onClick={() => setSelectedBatchId(b.id)} />
          ))}
        </div>
      ) : null}

      {selected.error && selected.error.status !== 404 ? <ErrorBanner error={selected.error} onRetry={selected.reload} /> : null}
      {selected.data ? (
        <div className="batch-detail">
          <BatchHeader
            batch={selected.data}
            reload={() => void selected.reload()}
            onDeleted={() => {
              setSelectedBatchId(null);
              void list.reload();
            }}
          />
          <JobsManager batch={selected.data} />
        </div>
      ) : null}
    </section>
  );
}
