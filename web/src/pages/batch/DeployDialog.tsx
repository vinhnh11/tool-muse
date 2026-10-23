import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Rocket, ShieldCheck } from "lucide-react";
import { api, ApiError, asApiError, IMAGE_CONFIRM_THRESHOLD, type DeployBody, type DeployResult, type DeploySelection, type PromptSet } from "../../api";
import { MockBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { CheckResultView, EstimateView } from "../../components/CheckResult";
import { Banner, ErrorBanner, Loading } from "../../components/EmptyState";
import { Checkbox, Field, Select } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { useDialogs } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { emitLocal } from "../../hooks/useEvents";
import { MODE_LABEL, fmtCost, fmtSeconds } from "../../labels";
import { useStudio } from "../../state/studio";
import { FbPageSelect, useFbPages } from "./FbPageSelect";
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
  kind = "video",
}: {
  set: PromptSet;
  cfg: ResolvedConfig;
  selection: DeploySelection;
  useItemOverrides: boolean;
  autoRunFree?: boolean;
  onClose: () => void;
  kind?: "video" | "image";
}) {
  const isImage = kind === "image";
  const unit = isImage ? "ảnh" : "video";
  const dialogs = useDialogs();
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
  const fb = useFbPages();
  const [fbPage, setFbPage] = useState("");
  const fbReady = isImage || fb.isReady(fbPage);
  const fbReadyRef = useRef(false);
  fbReadyRef.current = fbReady;

  const body = useCallback((): DeployBody => {
    const neg = cfg.model?.negativePrompt && cfg.state.negative.trim() ? cfg.state.negative.trim() : null;
    return {
      sessionId: sessionId ?? set.sessionId,
      providerConfigId: cfg.provider?.id,
      modelId: cfg.model?.modelId,
      ...(isImage ? { kind: "image" as const } : {}),
      config: cfg.config ? (isImage ? cfg.config : { ...cfg.config, variantsPerPrompt: 1 }) : undefined,
      selection,
      useItemOverrides,
      defaultNegative: neg,
      maxConcurrency: cfg.state.maxConcurrency,
      budgetLimit: cfg.budgetLimit,
      fbPage: isImage ? undefined : fb.toRequest(fbPage),
    };
  }, [cfg, selection, useItemOverrides, sessionId, set.sessionId, fb, fbPage, isImage]);

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
      const large = isImage && p.videoCount >= IMAGE_CONFIRM_THRESHOLD;
      if (large) {
        const eta = Math.max(1, Math.ceil((p.videoCount * 40) / Math.max(1, cfg.effectiveConcurrency) / 60));
        const ok = await dialogs.confirm({ title: `Tạo ${p.videoCount} ảnh?`, body: `Sẽ tạo ${p.videoCount} ảnh (~${eta} phút), tiêu hạn mức tuần của nick Muse. Tiếp tục?`, confirmLabel: `Tạo ${p.videoCount} ảnh` });
        if (!ok) return;
      }
      setBusy(true);
      setError(null);
      try {
        const total = p.estimate.total;
        const r = await api.deployPromptSet(set.id, { ...body(), run: { confirm: true, ...(total !== null ? { approvedMaxCost: total } : {}), acknowledgeUnknownCost: total === null ? acknowledged : false, ...(large ? { confirmLarge: true } : {}) } });
        if (r.batch) {
          setSelectedBatchId(r.batch.id);
          emitLocal({ type: "local.batch", batchId: r.batch.id });
        }
        if (r.approved) {
          toast.success(`Đã triển khai ${r.videoCount} ${unit}`, `${r.promptCount} prompt → ${r.videoCount} ${unit}, đang chạy. ${isImage ? "Ảnh" : "Video"} nào xong xem được ngay.`);
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
    [body, set.id, setSelectedBatchId, toast, onClose, openApproval, isImage, dialogs, cfg.effectiveConcurrency],
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
        // Đã có Page thì không tự chạy: người dùng phải chọn Page đích trước
        if (autoRunFree && !autoDone.current && !userPicked.current && p.free && p.check.ok && fb.loaded && fb.pages.length === 0) {
          autoDone.current = true;
          void deploy(p, false);
        }
      })
      .catch((e) => alive && setLoadError(asApiError(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set.id, provId, modId, fb.loaded]);

  /** Bộ prompt có negative nhưng model không nhận -> cho dọn ngay trong dialog */
  const negBlocked = Boolean(preview && !preview.check.ok && preview.check.items.some((it) => it.issues.some((g) => g.code === "NEGATIVE_UNSUPPORTED")));
  const unknown = preview ? preview.estimate.total === null : false;
  const currency = preview?.estimate.currency ?? "USD";
  const can = Boolean(fbReady && preview && preview.check.ok && preview.videoCount > 0 && (!unknown || ack) && !busy && preview.estimate.withinBudget !== false);
  const cfgLine = isImage ? `${cfg.state.aspectRatio} · ${cfg.state.variantsPerPrompt} ảnh/prompt · ${cfg.state.maxConcurrency} luồng` : cfg.config ? `${MODE_LABEL[cfg.config.mode]} · ${fmtSeconds(cfg.config.durationSec)} · ${cfg.config.aspectRatio} · ${cfg.config.resolution}${cfg.config.audio ? " · có âm thanh" : ""}` : "";

  return (
    <Modal
      open
      size="md"
      title={`Triển khai bộ prompt thành ${unit}`}
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
            {preview ? `Triển khai ${preview.videoCount} ${unit}` : "Triển khai"}
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
              <div className="muted small">{unit} sẽ được tạo</div>
            </div>
            <div className="approval-meta">
              <div>
                <strong>
                  {preview.promptCount} prompt → {preview.videoCount} {unit}
                </strong>{" "}
                <span className="muted small">{isImage ? `(mỗi prompt ${cfg.state.variantsPerPrompt} ảnh)` : "(mỗi prompt đúng 1 video)"}</span>
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
                {isImage ? null : (
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
                )}
              </div>
              {cfgLine ? (
                <div>
                  <span className="muted">Cấu hình:</span> {cfgLine}
                  {useItemOverrides ? <span className="muted small"> (prompt có thời lượng/tỷ lệ riêng thì giữ nguyên)</span> : null}
                </div>
              ) : null}
            </div>
          </div>
          {isImage ? null : <FbPageSelect pages={fb.pages} value={fbPage} onChange={setFbPage} disabled={busy} />}
          {!isImage && cfg.state.variantsPerPrompt > 1 ? <Banner tone="info">Triển khai luôn tạo 1 video cho mỗi prompt - bỏ qua “Số lần tạo mỗi prompt” ({cfg.state.variantsPerPrompt}).</Banner> : null}
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
              <Checkbox checked={ack} onChange={setAck} label={isImage ? "Tôi hiểu mỗi ảnh tiêu hạn mức của nick Muse" : "Tôi chấp nhận chi phí không xác định"} />
            </div>
          ) : null}
          {error ? <ErrorBanner error={error} title={error.code === "BATCH_INVALID" ? "Chưa triển khai - bộ prompt có lỗi" : undefined} /> : null}
          {preview.check.ok ? (
            <p className="muted small">
              Bấm “Triển khai” là tạo batch và chạy ngay
              {preview.free ? " (Mock - không tính phí)" : isImage ? ", mỗi ảnh tiêu hạn mức tuần của nick Muse" : `, bạn đồng ý chi phí tối đa ${preview.estimate.total !== null ? fmtCost(preview.estimate.total, currency) : "không xác định"}`}. {isImage ? "Ảnh" : "Video"} nào xong xem được ngay ở danh sách batch.
            </p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
