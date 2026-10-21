import { useState } from "react";
import { Rocket, Sparkles } from "lucide-react";
import { api, asApiError, type ApiError, type GenerateResult } from "../../api";
import { Button } from "../../components/Button";
import { ErrorBanner } from "../../components/EmptyState";
import { Checkbox, Field, Input, Select, TextArea } from "../../components/Field";
import { FilterChip } from "../../components/Tabs";
import { useLocalStorage } from "../../hooks/useApi";
import { GENRES, fmtSeconds } from "../../labels";
import { useStudio } from "../../state/studio";
import type { ResolvedConfig } from "./useVideoConfig";

/** "Tạo prompt bằng AI" từ mô tả/brief của người dùng */
export function AiGenerateForm({ cfg, onGenerated }: { cfg: ResolvedConfig; onGenerated: (r: GenerateResult, opts?: { deploy?: boolean }) => void }) {
  const { sessionId } = useStudio();

  const [count, setCount] = useState("10");
  const [genres, setGenres] = useState<string[]>(["product"]);
  const [brief, setBrief] = useState("");
  const [product, setProduct] = useState("");
  const [brand, setBrand] = useState("");
  const [character, setCharacter] = useState("");
  const [language, setLanguage] = useState<"vi" | "en">("vi");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [deployAfter, setDeployAfter] = useLocalStorage<boolean>("bvs.ai.deployAfter", false);

  const countNum = Math.round(Number(count));
  const countValid = Number.isFinite(countNum) && countNum >= 1 && countNum <= 10;

  const submit = async () => {
    if (!cfg.provider || !cfg.model) return;
    setBusy(true);
    setError(null);
    try {
      const consistency = { product: product.trim() || undefined, brand: brand.trim() || undefined, character: character.trim() || undefined };
      const r = await api.generatePromptSet({
        sessionId,
        count: countNum,
        durationSec: cfg.state.durationSec,
        aspectRatio: cfg.state.aspectRatio,
        providerConfigId: cfg.provider.id,
        modelId: cfg.model.modelId,
        genres,
        brief: brief.trim() || undefined,
        consistency: consistency.product || consistency.brand || consistency.character ? consistency : undefined,
        referenceAssetIds: cfg.needsReferences ? cfg.state.referenceAssetIds : undefined,
        language,
        name: name.trim() || undefined,
      });
      onGenerated(r, { deploy: deployAfter });
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-form">
      <div className="grid-3">
        <Field label="Số prompt" error={!countValid ? "Từ 1 đến 10" : undefined}>
          <Input type="number" min={1} max={10} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <Field label="Ngôn ngữ prompt">
          <Select
            value={language}
            onChange={(e) => setLanguage(e.target.value as "vi" | "en")}
            options={[
              { value: "vi", label: "Tiếng Việt" },
              { value: "en", label: "Tiếng Anh" },
            ]}
          />
        </Field>
        <Field label="Tên bộ prompt (tùy chọn)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vd: Serum - 50 ý tưởng" />
        </Field>
      </div>

      <div className="field">
        <span className="field-label">Thể loại (chọn nhiều)</span>
        <div className="chip-row">
          {GENRES.map((g) => (
            <FilterChip key={g.id} active={genres.includes(g.id)} onClick={() => setGenres((xs) => (xs.includes(g.id) ? xs.filter((x) => x !== g.id) : [...xs, g.id]))}>
              {g.label}
            </FilterChip>
          ))}
        </div>
      </div>

      <Field label="Brief / yêu cầu">
        <TextArea rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="vd: Quảng cáo serum vitamin C cho nữ 22-30 tuổi, tông sáng, nhấn mạnh da căng bóng, CTA mua tại shop" />
      </Field>

      <details className="disclosure">
        <summary>Giữ nhất quán (sản phẩm / thương hiệu / nhân vật)</summary>
        <div className="grid-3">
          <Field label="Sản phẩm">
            <Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="vd: chai serum thủy tinh hổ phách 30ml" />
          </Field>
          <Field label="Thương hiệu">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="vd: Lumi Skin" />
          </Field>
          <Field label="Nhân vật">
            <Input value={character} onChange={(e) => setCharacter(e.target.value)} placeholder="vd: cô gái tóc ngắn, áo len kem" />
          </Field>
        </div>
      </details>

      <Checkbox
        checked={deployAfter}
        onChange={setDeployAfter}
        label={
          <span className="pick-label">
            <strong>
              <Rocket size={13} aria-hidden /> Sinh xong triển khai luôn
            </strong>
            <span className="muted small">Mỗi prompt = 1 video ({countValid ? `${countNum} prompt → ${countNum} video` : "N prompt → N video"}). Mock chạy ngay; provider tính phí vẫn hiện chi phí để bạn xác nhận.</span>
          </span>
        }
      />

      <div className="ai-form-foot">
        <span className="muted small">
          Prompt viết cho {cfg.model ? <code>{cfg.model.modelId}</code> : "model đã chọn"} · {fmtSeconds(cfg.state.durationSec)} · {cfg.state.aspectRatio} (lấy từ Cấu hình video). Có thể mất 1-2 phút.
        </span>
        <Button variant="primary" icon={<Sparkles size={16} />} loading={busy} disabled={!cfg.model || !countValid || busy} onClick={submit}>
          {busy ? "AI đang viết prompt..." : deployAfter ? `Tạo ${countValid ? countNum : ""} prompt & triển khai` : `Tạo ${countValid ? countNum : ""} prompt bằng AI`}
        </Button>
      </div>
      <ErrorBanner error={error} title="Không sinh được prompt" />
    </div>
  );
}
