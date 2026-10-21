import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ImagePlus, Loader2, Settings2, Trash2, X } from "lucide-react";
import { api, asApiError, uploadAssets, type Asset } from "../../api";
import { MockBadge, ProviderStatusBadge } from "../../components/Badge";
import { Banner, ErrorBanner } from "../../components/EmptyState";
import { Field, Input, Select, TextArea, Toggle } from "../../components/Field";
import { Segmented } from "../../components/Tabs";
import { useDialogs } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { useApi } from "../../hooks/useApi";
import { MODE_LABEL, QUALITY_LABEL } from "../../labels";
import { useStudio } from "../../state/studio";
import { CONCURRENCY_OPTIONS, type ResolvedConfig } from "./useVideoConfig";

/** Ô số chỉ áp dụng khi rời ô / Enter (tránh bị kẹp giá trị khi đang gõ) */
function NumberField({ value, min, max, onCommit, disabled, ariaLabel }: { value: number; min: number; max: number; onCommit: (v: number) => void; disabled?: boolean; ariaLabel?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n)) return setDraft(String(value));
    const c = Math.min(max, Math.max(min, n));
    setDraft(String(c));
    if (c !== value) onCommit(c);
  };
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={draft}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

export function ReferencePicker({ cfg }: { cfg: ResolvedConfig }) {
  const { sessionId } = useStudio();
  const toast = useToast();
  const dialogs = useDialogs();
  const images = useApi(() => api.assets({ kind: "image", sessionId }).then((r) => r.assets), [sessionId]);
  const [uploading, setUploading] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const max = cfg.model?.maxReferenceImages ?? 0;
  const selected = cfg.state.referenceAssetIds;
  const mode = cfg.state.mode;
  const modes = cfg.model?.modes ?? [];
  // Có ảnh -> tự chuyển sang ảnh→video; bỏ hết ảnh -> về văn bản→video
  useEffect(() => {
    if (selected.length > 0 && mode === "text-to-video" && modes.includes("image-to-video")) cfg.set({ mode: "image-to-video" });
    else if (selected.length === 0 && mode === "image-to-video" && modes.includes("text-to-video")) cfg.set({ mode: "text-to-video" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.length, mode, modes.join(",")]);

  const toggle = (a: Asset) => {
    if (selected.includes(a.id)) cfg.set({ referenceAssetIds: selected.filter((x) => x !== a.id) });
    else if (selected.length >= max) toast.error(`Model chỉ nhận tối đa ${max} ảnh tham chiếu.`);
    else cfg.set({ referenceAssetIds: [...selected, a.id] });
  };

  /** Xóa hẳn ảnh tham chiếu khỏi máy (hỏi xác nhận; bỏ khỏi lựa chọn hiện tại) */
  const removeImage = async (a: Asset) => {
    const ok = await dialogs.confirm({
      title: "Xóa ảnh tham chiếu này?",
      body: `${a.fileName} sẽ bị xóa khỏi máy, không hoàn tác được. Nếu có job chưa xong đang dùng ảnh này thì hệ thống sẽ từ chối xóa.`,
      confirmLabel: "Xóa ảnh",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.deleteAssets([a.id]);
      if (r.skipped.length) {
        toast.error("Không xóa được ảnh", r.skipped[0]!.reason);
        return;
      }
      if (selected.includes(a.id)) cfg.set({ referenceAssetIds: selected.filter((x) => x !== a.id) });
      await images.reload();
      toast.success("Đã xóa ảnh");
    } catch (e) {
      toast.error("Không xóa được ảnh", asApiError(e).message);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(0);
    try {
      const out = await uploadAssets(Array.from(files), { kind: "image", sessionId }, setUploading);
      await images.reload();
      const room = Math.max(0, max - selected.length);
      if (room) cfg.set({ referenceAssetIds: [...selected, ...out.map((a) => a.id).slice(0, room)] });
      toast.success(`Đã tải lên ${out.length} ảnh`);
    } catch (e) {
      toast.error("Tải ảnh thất bại", asApiError(e).message);
    } finally {
      setUploading(null);
      if (input.current) input.current.value = "";
    }
  };

  if (max === 0) return <div className="muted small">Model này không nhận ảnh tham chiếu.</div>;
  return (
    <div className="ref-picker">
      <div className="ref-head">
        <span className="field-label">
          Ảnh sản phẩm tham chiếu ({selected.length}/{max})
        </span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => input.current?.click()} disabled={uploading !== null}>
          {uploading !== null ? <Loader2 size={14} className="spin" /> : <ImagePlus size={14} />}
          <span className="btn-label">{uploading !== null ? `Đang tải ${uploading}%` : "Tải ảnh lên"}</span>
        </button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => void upload(e.target.files)} />
      </div>
      {images.error ? <ErrorBanner error={images.error} compact onRetry={images.reload} /> : null}
      {images.data && !images.data.length ? <div className="muted small">Chưa có ảnh nào trong phiên này - tải ảnh sản phẩm/nhân vật lên để giữ nhất quán.</div> : null}
      <div className="ref-grid">
        {(images.data ?? []).map((a) => {
          const on = selected.includes(a.id);
          return (
            <div key={a.id} className="ref-cell">
              <button type="button" className={`ref-item${on ? " is-on" : ""}`} onClick={() => toggle(a)} title={a.fileName} aria-pressed={on}>
                <img src={a.urls.file} alt={a.fileName} loading="lazy" />
                {on ? <span className="ref-check">{selected.indexOf(a.id) + 1}</span> : null}
              </button>
              <button type="button" className="ref-del" aria-label={`Xóa ảnh ${a.fileName}`} title="Xóa ảnh này" onClick={() => void removeImage(a)}>
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {selected.some((id) => !(images.data ?? []).some((a) => a.id === id)) ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => cfg.set({ referenceAssetIds: selected.filter((id) => (images.data ?? []).some((a) => a.id === id)) })}>
          <X size={14} />
          <span className="btn-label">Bỏ ảnh không còn trong phiên</span>
        </button>
      ) : null}
    </div>
  );
}

export function VideoConfigPanel({ cfg }: { cfg: ResolvedConfig }) {
  const { providersLoading, providersError, reloadProviders, providers, navigate } = useStudio();
  const { state, set, provider, model, usableProviders } = cfg;

  if (providersLoading) return <div className="skeleton" style={{ height: 320 }} />;
  if (providersError) return <ErrorBanner error={providersError} onRetry={reloadProviders} title="Không tải được provider" />;
  if (!usableProviders.length)
    return (
      <Banner
        tone="warning"
        icon={<AlertTriangle size={16} />}
        title="Chưa có provider video nào đang bật"
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate("providers")}>
            <Settings2 size={14} />
            <span className="btn-label">Mở trang Provider</span>
          </button>
        }
      >
        {providers.length ? "Mọi provider đều đang tắt." : "Thêm provider (Seedance hoặc Mock) để tạo video."}
      </Banner>
    );

  return (
    <div className="config-panel">
      <div className="grid-2">
        <Field label="Provider">
          <Select
            value={state.providerId}
            onChange={(e) => set({ providerId: e.target.value, modelId: "" })}
            options={usableProviders.map((p) => ({ value: p.id, label: `${p.name}${p.status === "needs_key" ? " (thiếu API key)" : ""}` }))}
          />
        </Field>
        <Field label="Model">
          <Select value={state.modelId} onChange={(e) => set({ modelId: e.target.value })} options={(provider?.capabilities.models ?? []).map((m) => ({ value: m.modelId, label: m.label || m.modelId }))} />
        </Field>
      </div>

      {provider && (provider.status !== "active" || (model && !model.verified)) ? (
        <div className="config-badges">
          <ProviderStatusBadge status={provider.status} />
          {provider.providerType === "mock" ? <MockBadge /> : null}
          {model && !model.verified ? (
            <span className="badge tone-warning" title="Model id tự thêm - dùng giới hạn an toàn">
              Thông số chưa xác minh
            </span>
          ) : null}
        </div>
      ) : null}
      {provider?.status === "needs_key" ? (
        <Banner
          tone="warning"
          icon={<AlertTriangle size={16} />}
          actions={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate("providers")}>
              Nhập API key
            </button>
          }
        >
          Provider chưa có API key - batch sẽ bị chặn khi kiểm tra.
        </Banner>
      ) : null}

      {model ? (
        <>
          <div className="muted tiny">Chế độ: {MODE_LABEL[state.mode] ?? state.mode}{model.modes.length > 1 ? " (tự đổi theo việc có ảnh tham chiếu)" : ""}</div>

          {model.qualityModes.length ? (
            <Field label="Tốc độ / chất lượng">
              <Segmented ariaLabel="Chất lượng" value={state.quality ?? model.qualityModes[0]!} onChange={(v) => set({ quality: v })} options={model.qualityModes.map((q) => ({ id: q, label: QUALITY_LABEL[q] ?? q }))} />
            </Field>
          ) : null}

          <div className="grid-2">
            <Field label="Thời lượng (s)" hint={`${model.durations.min}-${model.durations.max}s · prompt ghi "dài N giây" thì theo prompt`}>
              <div className="duration-row">
                <NumberField ariaLabel="Thời lượng" value={state.durationSec === -1 ? Math.min(model.durations.max, Math.max(model.durations.min, 8)) : state.durationSec} min={model.durations.min} max={model.durations.max} disabled={state.durationSec === -1} onCommit={(v) => set({ durationSec: v })} />
                {model.durations.auto ? (
                  <label className="checkbox">
                    <input type="checkbox" checked={state.durationSec === -1} onChange={(e) => set({ durationSec: e.target.checked ? -1 : Math.min(model.durations.max, Math.max(model.durations.min, 8)) })} />
                    <span>Model tự chọn</span>
                  </label>
                ) : null}
              </div>
            </Field>
            <Field label="Tỷ lệ khung">
              <Select value={state.aspectRatio} onChange={(e) => set({ aspectRatio: e.target.value })} options={model.aspectRatios.map((r) => ({ value: r, label: r }))} />
            </Field>
            <Field label="Độ phân giải">
              <Select value={state.resolution} onChange={(e) => set({ resolution: e.target.value })} options={model.resolutions.map((r) => ({ value: r, label: r }))} />
            </Field>
            <Field label="Số bản / prompt">
              <NumberField ariaLabel="Số lần tạo mỗi prompt" value={state.variantsPerPrompt} min={1} max={10} onCommit={(v) => set({ variantsPerPrompt: v })} />
            </Field>
          </div>

          <Toggle
            checked={model.audio ? state.audio : false}
            disabled={!model.audio}
            onChange={(v) => set({ audio: v })}
            label="Âm thanh"
            title={model.audio ? undefined : "Model này không tạo âm thanh"}
            description={model.audio ? "Model tạo kèm âm thanh" : "Model này không hỗ trợ âm thanh"}
          />

          {model.negativePrompt ? (
            <Field label="Negative prompt (tùy chọn)" hint="Áp dụng cho các prompt chưa có negative riêng">
              <TextArea rows={2} value={state.negative} placeholder="vd: chữ méo, logo sai, tay biến dạng" onChange={(e) => set({ negative: e.target.value })} />
            </Field>
          ) : null}

          <details className="config-advanced">
            <summary className="small">Nâng cao: luồng, ngân sách</summary>
          <div className="grid-2">
            <Field
              label="Số luồng tối đa"
              hint={
                provider ? (
                  <>
                    Provider cho phép {provider.maxConcurrency} luồng → hệ thống chạy tối đa <strong>{cfg.effectiveConcurrency}</strong> job cùng lúc.
                  </>
                ) : undefined
              }
            >
              <Select value={String(state.maxConcurrency)} onChange={(e) => set({ maxConcurrency: Number(e.target.value) })} options={CONCURRENCY_OPTIONS.map((n) => ({ value: String(n), label: `${n} luồng${provider && n > provider.maxConcurrency ? ` (thực tế ${provider.maxConcurrency})` : ""}` }))} />
            </Field>
            <Field label={`Ngân sách tối đa (${String(provider?.options.currency ?? "USD")}, tùy chọn)`} error={cfg.budgetInvalid ? "Ngân sách phải là số ≥ 0" : undefined} hint={provider?.capabilities.pricing === "unknown" ? "Provider chưa có đơn giá - ngân sách không kiểm được" : "Để trống = không giới hạn"}>
              <Input inputMode="decimal" value={state.budget} placeholder="vd: 25" onChange={(e) => set({ budget: e.target.value })} />
            </Field>
          </div>
          </details>

          {model.notes.length ? (
            <details className="model-notes">
              <summary className="small">Ghi chú về model ({model.notes.length})</summary>
              <ul>
                {model.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <Banner tone="warning">Provider chưa có model nào.</Banner>
      )}
    </div>
  );
}
