import { useEffect, useState } from "react";
import { ExternalLink, PlayCircle, ShieldCheck } from "lucide-react";
import { api, asApiError, IMAGE_CONFIRM_THRESHOLD, type ApiError, type Batch, type BatchEstimate } from "../api";
import { emitLocal } from "../hooks/useEvents";
import { BATCH_STATUS_META, MODE_LABEL, QUALITY_LABEL, fmtCost, fmtSeconds } from "../labels";
import { useStudio } from "../state/studio";
import { BatchStatusBadge, MockBadge } from "./Badge";
import { Button } from "./Button";
import { EstimateView } from "./CheckResult";
import { ErrorBanner, Loading } from "./EmptyState";
import { Checkbox } from "./Field";
import { useDialogs } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

const ESTIMATE_ERRORS = new Set(["COST_CONFIRMATION_MISMATCH", "BUDGET_EXCEEDED", "BUDGET_UNVERIFIABLE", "COST_UNKNOWN_ACK_REQUIRED"]);

function isEstimate(x: unknown): x is BatchEstimate {
  return Boolean(x && typeof x === "object" && "effectiveConcurrency" in x && "total" in x);
}

/** Dialog DUYỆT & CHẠY batch - dùng chung cho Batch Studio và thẻ chat */
export function ApprovalDialog({ batchId, initialEstimate, onClose }: { batchId: string; initialEstimate: BatchEstimate | null; onClose: () => void }) {
  const { setSelectedBatchId, navigate } = useStudio();
  const toast = useToast();
  const dialogs = useDialogs();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [estimate, setEstimate] = useState<BatchEstimate | null>(initialEstimate);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .batch(batchId)
      .then((b) => {
        if (!alive) return;
        setBatch(b);
        setEstimate((e) => e ?? b.estimate);
      })
      .catch((e) => alive && setLoadError(asApiError(e)));
    return () => {
      alive = false;
    };
  }, [batchId]);

  const total = estimate?.total ?? null;
  const unknown = estimate ? estimate.total === null : batch?.estimatedCost === null;
  const awaiting = batch?.status === "awaiting_approval";
  const jobCount = batch ? (batch.status === "awaiting_approval" ? (batch.counts.awaiting_approval ?? 0) : batch.total) : (estimate?.jobCount ?? 0);
  const currency = estimate?.currency ?? batch?.currency ?? "USD";

  const isImage = batch?.kind === "image";
  const unit = isImage ? "ảnh" : "video";

  const approve = async () => {
    if (!batch) return;
    const large = isImage && jobCount >= IMAGE_CONFIRM_THRESHOLD;
    if (large) {
      const eta = Math.max(1, Math.ceil((jobCount * 40) / Math.max(1, estimate?.effectiveConcurrency ?? batch.maxConcurrency) / 60));
      const ok = await dialogs.confirm({ title: `Tạo ${jobCount} ảnh?`, body: `Sẽ tạo ${jobCount} ảnh (~${eta} phút), tiêu hạn mức tuần của nick Muse. Tiếp tục?`, confirmLabel: `Tạo ${jobCount} ảnh` });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.approveBatch(batch.id, {
        confirm: true,
        ...(total !== null ? { approvedMaxCost: total } : {}),
        acknowledgeUnknownCost: unknown ? ack : false,
        ...(large ? { confirmLarge: true } : {}),
      });
      toast.success("Đã duyệt - batch bắt đầu chạy", `${jobCount} ${unit} vào hàng đợi.`);
      setSelectedBatchId(batch.id);
      emitLocal({ type: "local.batch", batchId: batch.id });
      onClose();
    } catch (e) {
      const err = asApiError(e);
      if (ESTIMATE_ERRORS.has(err.code) && isEstimate(err.details)) {
        setEstimate(err.details);
        setAck(false);
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="md"
      title="Duyệt & chạy batch"
      subtitle={batch ? batch.name : undefined}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <Button
            variant="ghost"
            icon={<ExternalLink size={14} />}
            onClick={() => {
              setSelectedBatchId(batchId);
              navigate("batch");
              onClose();
            }}
          >
            Xem batch
          </Button>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Để sau
          </Button>
          <Button variant="primary" icon={<PlayCircle size={16} />} loading={busy} disabled={!batch || !awaiting || jobCount === 0 || (unknown && !ack)} onClick={approve}>
            Duyệt & chạy
          </Button>
        </>
      }
    >
      {loadError ? <ErrorBanner error={loadError} /> : null}
      {!batch && !loadError ? <Loading /> : null}
      {batch ? (
        <div className="approval">
          {awaiting && jobCount === 0 ? <div className="banner banner-warning">Batch không còn job nào chờ duyệt (đã hủy hết) - không có gì để chạy.</div> : null}
          {!awaiting ? (
            <div className="banner banner-info">
              <div className="banner-body">
                Batch đang ở trạng thái <strong>{BATCH_STATUS_META[batch.status]?.label ?? batch.status}</strong> - không cần duyệt nữa.
              </div>
            </div>
          ) : null}
          <div className="approval-hero">
            <div>
              <div className="approval-count">{jobCount}</div>
              <div className="muted small">{unit} sẽ được tạo</div>
            </div>
            <div className="approval-meta">
              <div>
                <span className="muted">Provider:</span> {batch.providerName ?? batch.providerConfigId}
              </div>
              <div>
                <span className="muted">Model:</span> <code>{batch.modelId}</code>
              </div>
              <div>
                <span className="muted">Cấu hình:</span>{" "}
                {isImage ? `${batch.config.aspectRatio} · ${batch.config.variantsPerPrompt} ảnh/prompt` : `${MODE_LABEL[batch.config.mode]} · ${fmtSeconds(batch.config.durationSec)} · ${batch.config.aspectRatio} · ${batch.config.resolution}`}
                {!isImage && batch.config.audio ? " · có âm thanh" : ""}
                {!isImage && batch.config.quality ? ` · ${QUALITY_LABEL[batch.config.quality] ?? batch.config.quality}` : ""}
                {!isImage && batch.config.variantsPerPrompt > 1 ? ` · ${batch.config.variantsPerPrompt} lần/prompt` : ""}
              </div>
              {isImage ? null : (
                <div>
                  <span className="muted">Ngân sách tối đa:</span> {batch.budgetLimit !== null ? fmtCost(batch.budgetLimit, currency) : "không đặt"}
                </div>
              )}
              <div>
                <span className="muted">Số luồng bạn chọn:</span> {batch.maxConcurrency}
              </div>
              <BatchStatusBadge status={batch.status} />
            </div>
          </div>
          {batch.providerType === "mock" ? <MockBadge /> : null}
          {estimate ? <EstimateView estimate={estimate} /> : <div className="muted">Chưa có ước tính chi phí.</div>}
          {unknown && awaiting ? (
            <div className="ack-box">
              <ShieldCheck size={16} aria-hidden />
              <Checkbox checked={ack} onChange={setAck} label={isImage ? "Tôi hiểu mỗi ảnh tiêu hạn mức tuần của nick Muse" : "Tôi chấp nhận chi phí không xác định"} />
            </div>
          ) : null}
          {error ? <ErrorBanner error={error} title={error.code === "COST_CONFIRMATION_MISMATCH" ? "Ước tính đã thay đổi - kiểm tra lại con số rồi xác nhận lần nữa" : undefined} /> : null}
          {awaiting ? <p className="muted small">Bấm "Duyệt & chạy" là bạn đồng ý {isImage ? "tiêu hạn mức nick Muse cho các ảnh này" : `chi phí tối đa ${total !== null ? fmtCost(total, currency) : "không xác định"}`}. Hệ thống không gửi yêu cầu nào tới provider trước bước này.</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}
