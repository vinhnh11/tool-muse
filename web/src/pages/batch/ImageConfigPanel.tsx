import { AlertTriangle, Settings2 } from "lucide-react";
import { IMAGE_ASPECT_RATIOS } from "../../api";
import { Banner } from "../../components/EmptyState";
import { Field, Select } from "../../components/Field";
import { fmtNumber } from "../../labels";
import { useStudio } from "../../state/studio";
import { NumberField } from "./VideoConfigPanel";
import { IMAGE_MODEL, type ResolvedImageConfig } from "./useImageConfig";

const RATIO_LABEL: Record<string, string> = { "1:1": "1:1 (vuông)", "4:5": "4:5 (dọc ngắn)", "9:16": "9:16 (dọc)", "16:9": "16:9 (ngang)", "3:4": "3:4 (dọc)" };

/** Cấu hình batch ẢNH: tỉ lệ, số ảnh mỗi prompt, số luồng. Ảnh tham chiếu chọn ở Khu vực tạo. */
export function ImageConfigPanel({ img, promptCount }: { img: ResolvedImageConfig; promptCount: number | null }) {
  const { providersLoading, navigate } = useStudio();
  const { state, set, provider, usableProviders } = img;
  if (providersLoading) return <div className="skeleton" style={{ height: 240 }} />;
  if (!usableProviders.length)
    return (
      <Banner
        tone="warning"
        icon={<AlertTriangle size={16} />}
        title="Chưa có provider Muse nào đang bật"
        actions={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate("providers")}>
            <Settings2 size={14} />
            <span className="btn-label">Mở trang Provider</span>
          </button>
        }
      >
        Tạo ảnh hàng loạt dùng provider Muse (muse2api). Thêm provider loại “Muse” ở trang Provider.
      </Banner>
    );
  const total = promptCount === null ? null : promptCount * state.variantsPerPrompt;
  const eta = total ? Math.max(1, Math.ceil((total * 40) / img.effectiveConcurrency / 60)) : null;
  return (
    <div className="config-panel">
      <Field label="Provider">
        <Select value={state.providerId} onChange={(e) => set({ providerId: e.target.value })} options={usableProviders.map((p) => ({ value: p.id, label: `${p.name}${p.status === "needs_key" ? " (thiếu API key)" : ""}` }))} />
      </Field>
      <div className="muted tiny">
        Model: <code>{IMAGE_MODEL.modelId}</code> · không có thời lượng, độ phân giải hay âm thanh
      </div>
      <div className="grid-2">
        <Field label="Tỉ lệ khung hình" hint={state.aspectRatio === "4:5" ? "4:5 có thể lệch tỉ lệ hơn các tỉ lệ khác" : undefined}>
          <Select value={state.aspectRatio} onChange={(e) => set({ aspectRatio: e.target.value })} options={IMAGE_ASPECT_RATIOS.map((r) => ({ value: r, label: RATIO_LABEL[r] ?? r }))} />
        </Field>
        <Field label="Số ảnh / prompt" hint="1-4 biến thể cho mỗi prompt">
          <NumberField ariaLabel="Số ảnh mỗi prompt" value={state.variantsPerPrompt} min={1} max={4} onCommit={(v) => set({ variantsPerPrompt: v })} />
        </Field>
      </div>
      <Field
        label="Số ảnh chạy song song"
        hint={
          provider && provider.maxConcurrency < state.maxConcurrency ? (
            <span className="text-warning">
              Provider Muse đang giới hạn {provider.maxConcurrency} luồng - tăng “Số luồng tối đa” ở trang Provider để đạt {state.maxConcurrency}.
            </span>
          ) : (
            "Mặc định 3. Quá cao dễ bị muse2api từ chối vì hàng đợi đầy."
          )
        }
      >
        <Select value={String(state.maxConcurrency)} onChange={(e) => set({ maxConcurrency: Number(e.target.value) })} options={[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} luồng` }))} />
      </Field>
      <div className="source-summary">
        <div className="muted tiny">Ước tính</div>
        <div className="source-count">
          {total === null ? "Chưa có prompt" : `${fmtNumber(promptCount ?? 0)} prompt × ${state.variantsPerPrompt} = ${fmtNumber(total)} ảnh`}
        </div>
        {eta ? <div className="muted tiny">≈ {eta} phút (~40 giây/ảnh, {img.effectiveConcurrency} luồng). Mỗi ảnh tiêu hạn mức tuần của nick Muse.</div> : null}
      </div>
    </div>
  );
}
