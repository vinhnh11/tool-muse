import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Rocket, ShieldCheck } from "lucide-react";
import { api, ApiError, asApiError, type DeployBody, type DeployResult, type DeploySelection, type PromptSet } from "../../api";
import { MockBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { CheckResultView, EstimateView } from "../../components/CheckResult";
import { Banner, ErrorBanner, Loading } from "../../components/EmptyState";
import { Checkbox, Field, Select } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { emitLocal } from "../../hooks/useEvents";
import { MODE_LABEL, fmtCost, fmtSeconds } from "../../labels";
import { useStudio } from "../../state/studio";
import type { ResolvedConfig } from "./useVideoConfig";

/**
 * TRIỂN KHAI bộ prompt: mỗi prompt = đúng 1 video. Xem trước (dryRun: số video + kiểm lỗi +
 * chi phí) rồi một lần bấm "Triển khai & chạy". Provider miễn phí (Mock) + autoRunFree → chạy
 * luôn không cần bấm. Provider tính phí luôn phải xác nhận con số chi phí.
 */
export function DeployDialog({
  set,
  cfg,
  selection,
  useItemOverrides,
  autoRunFree,
  onClose,
}: {
  set: PromptSet;
  cfg: ResolvedConfig;
  selection: DeploySelection;
  useItemOverrides: boolean;
  autoRunFree?: boolean;
  onClose: () => void;
}) {
  const { sessionId, setSelectedBatchId, openApproval } = useStudio();
  const toast = useToast();
  const [preview, setPreview] = useState<DeployResult | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const autoDone = useRef(false);
  /** Người dùng tự đổi provider/model trong dialog -> không auto-chạy nữa, phải bấm tay */
  const userPicked = useRef(false);
  const [fixing, setFixing] = useState(false);

  const body = useCallback((): DeployBody => {
    const neg = cfg.model?.negativePrompt && cfg.state.negative.trim() ? cfg.state.negative.trim() : null;
    return {
      sessionId: sessionId ?? set.sessionId,
      providerConfigId: cfg.provider?.id,
      modelId: cfg.model?.modelId,
      config: cfg.config ? { ...cfg.config, variantsPerPrompt: 1 } : undefined,
      selection,
      useItemOverrides,
      defaultNegative: neg,
      maxConcurrency: cfg.state.maxConcurrency,
      budgetLimit: cfg.budgetLimit,
    };
  }, [cfg, selection, useItemOverrides, sessionId, set.sessionId]);

  /** Dọn negative cả bộ rồi tính lại - dùng khi model không nhận negative (vd Muse) */
  const clearNegatives = useCallback(async () => {
    setFixing(true);
    setError(null);
    try {
      const r = await api.clearNegatives(set.id);
      toast.success(`Đã dọn negative ${r.cleared} prompt`, "Model này không nhận negative - đã bỏ trống để triển khai được.");
      const next = await api.deployPromptSet(set.id, { ...body(), dryRun: true });
      setPreview(next);
      setAck(false);
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setFixing(false);
    }
  }, [set.id, body, toast]);

  const deploy = useCallback(
    async (p: DeployResult, acknowledged: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const total = p.estimate.total;
        const r = await api.deployPromptSet(set.id, { ...body(), run: { confirm: true, ...(total !== null ? { approvedMaxCost: total } : {}), acknowledgeUnknownCost: total === null ? acknowledged : false } });
        if (r.batch) {
          setSelectedBatchId(r.batch.id);
          emitLocal({ type: "local.batch", batchId: r.batch.id });
        }
        if (r.approved) {
          toast.success(`Đã triển khai ${r.videoCount} video`, `${r.promptCount} prompt → ${r.videoCount} video, đang chạy. Video nào xong xem được ngay.`);
          onClose();
          setTimeout(() => document.querySelector(".batches-card")?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
        } else {
          // Batch đã tạo nhưng chưa duyệt được (ước tính đổi, ngân sách...) → mở dialog duyệt thường
          toast.show({ kind: "warning", title: "Đã tạo batch nhưng chưa chạy", detail: r.approveError?.message ?? "Cần duyệt lại." }, 9000);
          onClose();
          if (r.batch) openApproval(r.batch.id, r.estimate);
        }
      } catch (e) {
        setError(asApiError(e));
      } finally {
        setBusy(false);
      }
    },
    [body, set.id, setSelectedBatchId, toast, onClose, openApproval],
  );

  const provId = cfg.provider?.id ?? "";
  const modId = cfg.model?.modelId ?? "";

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    if (!cfg.provider || !cfg.model) {
      setLoadError(new ApiError("NO_PROVIDER", "Chưa có provider nào dùng được - thêm provider ở trang Provider trước.", 400));
      return;
    }
    // Đổi provider/model thì phải tick lại xác nhận chi phí (ước tính đã khác)
    setPreview(null);
    setAck(false);
    setError(null);
    api
      .deployPromptSet(set.id, { ...body(), dryRun: true })
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        if (autoRunFree && !autoDone.current && !userPicked.current && p.free && p.check.ok) {
          autoDone.current = true;
          void deploy(p, false);
        }
      })
      .catch((e) => alive && setLoadError(asApiError(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id, provId, modId]);

  /** Bộ prompt có negative nhưng model không nhận -> cho dọn ngay trong dialog */
  const negBlocked = Boolean(preview && !preview.check.ok && preview.check.items.some((it) => it.issues.some((g) => g.code === "NEGATIVE_UNSUPPORTED")));
  const unknown = preview ? preview.estimate.total === null : false;
  const currency = preview?.estimate.currency ?? "USD";
  const can = Boolean(preview && preview.check.ok && preview.videoCount > 0 && (!unknown || ack) && !busy && preview.estimate.withinBudget !== false);
  const cfgLine = cfg.config ? `${MODE_LABEL[cfg.config.mode]} · ${fmtSeconds(cfg.config.durationSec)} · ${cfg.config.aspectRatio} · ${cfg.config.resolution}${cfg.config.audio ? " · có âm thanh" : ""}` : "";

  return (
    <Modal
      open
      size="md"
      title="Triển khai bộ prompt thành video"
      subtitle={set.name}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Để sau
          </Button>
          <Button variant="primary" icon={<Rocket size={16} />} loading={busy} disabled={!can} onClick={() => preview && void deploy(preview, ack)}>
            {preview ? `Triển khai ${preview.videoCount} video` : "Triển khai"}
          </Button>
        </>
      }
    >
      {loadError ? <ErrorBanner error={loadError} title="Không chuẩn bị được việc triển khai" /> : null}
      {!preview && !loadError ? <Loading label="Đang kiểm prompt và ước tính chi phí..." /> : null}
      {preview ? (
        <div className="approval">
          <div className="approval-hero">
            <div>
              <div className="approval-count">{preview.videoCount}</div>
              <div className="muted small">video sẽ được tạo</div>
            </div>
            <div className="approval-meta">
              <div>
                <strong>
                  {preview.promptCount} prompt → {preview.videoCount} video
                </strong>{" "}
                <span className="muted small">(mỗi prompt đúng 1 video)</span>
              </div>
              <div>
                <span className="muted">Prompt dùng:</span> {selection === "approved" ? "chỉ prompt đã duyệt" : selection === "all" ? "mọi prompt chưa bị loại" : "prompt đã duyệt (nếu có), không thì mọi prompt chưa bị loại"}
              </div>
              <div className="deploy-picker">
                <Field label="Provider" className="w-full">
                  <Select
                    value={cfg.state.providerId}
                    disabled={busy}
                    onChange={(e) => {
                      userPicked.current = true;
                      cfg.set({ providerId: e.target.value, modelId: "" });
                    }}
                    options={cfg.usableProviders.map((p) => ({
                      value: p.id,
                      label: `${p.name}${p.providerType === "mock" ? " (test - không ra video AI)" : ""}${p.status !== "active" ? " · chưa kiểm tra" : ""}`,
                    }))}
                  />
                </Field>
                <Field label="Model" className="w-full">
                  <Select
                    value={cfg.state.modelId}
                    disabled={busy || !cfg.provider}
                    onChange={(e) => {
                      userPicked.current = true;
                      cfg.set({ modelId: e.target.value });
                    }}
                    options={(cfg.provider?.capabilities.models ?? []).map((m) => ({ value: m.modelId, label: m.modelId }))}
                  />
                </Field>
              </div>
              {cfgLine ? (
                <div>
                  <span className="muted">Cấu hình:</span> {cfgLine}
                  {useItemOverrides ? <span className="muted small"> (prompt có thời lượng/tỷ lệ riêng thì giữ nguyên)</span> : null}
                </div>
              ) : null}
            </div>
          </div>
          {cfg.state.variantsPerPrompt > 1 ? <Banner tone="info">Triển khai luôn tạo 1 video cho mỗi prompt - bỏ qua “Số lần tạo mỗi prompt” ({cfg.state.variantsPerPrompt}).</Banner> : null}
          {preview.free ? <MockBadge /> : null}
          {!preview.check.ok ? (
            <>
              <Banner tone="warning">Bộ prompt còn lỗi nên chưa triển khai được - sửa/loại các prompt dưới đây rồi thử lại. Chưa gọi provider, chưa tốn phí.</Banner>
              {negBlocked ? (
                <div className="ack-box">
                  <Eraser size={16} aria-hidden />
                  <span className="small">
                    Model <strong>{cfg.model?.label ?? cfg.state.modelId}</strong> không nhận negative prompt. Dọn negative cả bộ là triển khai được ngay (prompt chính giữ nguyên).
                  </span>
                  <span className="spacer" />
                  <Button variant="ghost" loading={fixing} disabled={busy} onClick={() => void clearNegatives()}>
                    Dọn negative cả bộ
                  </Button>
                </div>
              ) : null}
              <CheckResultView check={preview.check} limit={20} />
            </>
          ) : null}
          <EstimateView estimate={preview.estimate} />
          {unknown && preview.check.ok ? (
            <div className="ack-box">
              <ShieldCheck size={16} aria-hidden />
              <Checkbox checked={ack} onChange={setAck} label="Tôi chấp nhận chi phí không xác định" />
            </div>
          ) : null}
          {error ? <ErrorBanner error={error} title={error.code === "BATCH_INVALID" ? "Chưa triển khai - bộ prompt có lỗi" : undefined} /> : null}
          {preview.check.ok ? (
            <p className="muted small">
              Bấm “Triển khai” là tạo batch và chạy ngay
              {preview.free ? " (Mock - không tính phí)" : `, bạn đồng ý chi phí tối đa ${preview.estimate.total !== null ? fmtCost(preview.estimate.total, currency) : "không xác định"}`}. Video nào xong xem được ngay ở danh sách batch.
            </p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
