import { useMemo, useState } from "react";
import { ScanSearch, Sparkles } from "lucide-react";
import { api, asApiError, type ApiError, type GenerateResult } from "../../api";
import { Button } from "../../components/Button";
import { Banner, ErrorBanner, Loading } from "../../components/EmptyState";
import { Checkbox, Field, Input, Select, TextArea } from "../../components/Field";
import { FilterChip } from "../../components/Tabs";
import { useApi } from "../../hooks/useApi";
import { useRealtimeRefetch } from "../../hooks/useEvents";
import { GENRES, fmtSeconds, truncate } from "../../labels";
import { useStudio } from "../../state/studio";
import type { ResolvedConfig } from "./useVideoConfig";

/** "Tạo prompt bằng AI" từ các bản phân tích video của phiên */
export function AiGenerateForm({ cfg, onGenerated }: { cfg: ResolvedConfig; onGenerated: (r: GenerateResult) => void }) {
  const { sessionId, navigate } = useStudio();
  const analyses = useApi(() => api.analyses({ sessionId }).then((r) => r.analyses), [sessionId]);
  const assets = useApi(() => api.assets({ kind: "reference", sessionId }).then((r) => r.assets), [sessionId]);
  useRealtimeRefetch((ev) => ev.type.startsWith("analysis."), () => void analyses.reload(), 600);

  const [picked, setPicked] = useState<string[]>([]);
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

  const completed = useMemo(() => (analyses.data ?? []).filter((a) => a.status === "completed"), [analyses.data]);
  const pending = (analyses.data ?? []).filter((a) => a.status === "queued" || a.status === "running").length;
  const nameOf = (assetId: string) => assets.data?.find((a) => a.id === assetId)?.fileName ?? assetId;
  const countNum = Math.round(Number(count));
  const countValid = Number.isFinite(countNum) && countNum >= 1 && countNum <= 200;

  const submit = async () => {
    if (!cfg.provider || !cfg.model) return;
    setBusy(true);
    setError(null);
    try {
      const consistency = { product: product.trim() || undefined, brand: brand.trim() || undefined, character: character.trim() || undefined };
      const r = await api.generatePromptSet({
        sessionId,
        analysisIds: picked,
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
      onGenerated(r);
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-form">
      <div className="field">
        <span className="field-label">Bản phân tích làm nguồn ý tưởng ({picked.length} đã chọn)</span>
        {analyses.loading ? <Loading inline /> : null}
        {analyses.error ? <ErrorBanner error={analyses.error} compact onRetry={analyses.reload} /> : null}
        {!analyses.loading && !completed.length ? (
          <Banner
            tone="neutral"
            icon={<ScanSearch size={16} />}
            actions={
              <Button size="sm" variant="secondary" onClick={() => navigate("analysis")}>
                Phân tích video
              </Button>
            }
          >
            {pending ? `${pending} video đang được phân tích. ` : "Phiên này chưa có bản phân tích hoàn thành. "}Bạn vẫn có thể sinh prompt chỉ từ brief bên dưới.
          </Banner>
        ) : (
          <div className="pick-list">
            {completed.map((a) => (
              <Checkbox
                key={a.id}
                checked={picked.includes(a.id)}
                onChange={(on) => setPicked((xs) => (on ? [...xs, a.id] : xs.filter((x) => x !== a.id)))}
                label={
                  <span className="pick-label">
                    <strong>{nameOf(a.assetId)}</strong>
                    <span className="muted small">{a.result?.content.summary ? truncate(a.result.content.summary, 120) : "Đã phân tích"}</span>
                  </span>
                }
              />
            ))}
          </div>
        )}
      </div>

      <div className="grid-3">
        <Field label="Số prompt" error={!countValid ? "Từ 1 đến 200" : undefined}>
          <Input type="number" min={1} max={200} value={count} onChange={(e) => setCount(e.target.value)} />
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

      <div className="ai-form-foot">
        <span className="muted small">
          Prompt viết cho {cfg.model ? <code>{cfg.model.modelId}</code> : "model đã chọn"} · {fmtSeconds(cfg.state.durationSec)} · {cfg.state.aspectRatio} (lấy từ Cấu hình video). Có thể mất 1-2 phút.
        </span>
        <Button variant="primary" icon={<Sparkles size={16} />} loading={busy} disabled={!cfg.model || !countValid || busy} onClick={submit}>
          {busy ? "AI đang viết prompt..." : `Tạo ${countValid ? countNum : ""} prompt bằng AI`}
        </Button>
      </div>
      <ErrorBanner error={error} title="Không sinh được prompt" />
    </div>
  );
}
