import { useEffect, useMemo } from "react";
import type { ImageBatchConfig, ModelCaps, ProviderConfig } from "../../api";
import { IMAGE_ASPECT_RATIOS, IMAGE_MODEL_ID } from "../../api";
import { useLocalStorage } from "../../hooks/useApi";
import type { ResolvedConfig, VideoConfigState } from "./useVideoConfig";

export interface ImageConfigState {
  providerId: string;
  aspectRatio: string;
  variantsPerPrompt: number;
  /** 1 ảnh tham chiếu sản phẩm */
  referenceAssetIds: string[];
  /** số ảnh chạy song song (1-6) */
  maxConcurrency: number;
  maxAttempts: number;
}

const DEFAULT: ImageConfigState = { providerId: "", aspectRatio: "1:1", variantsPerPrompt: 1, referenceAssetIds: [], maxConcurrency: 3, maxAttempts: 3 };

/** Model ảnh "ảo" để các thành phần dùng chung (ReferencePicker, form AI...) đọc giới hạn */
export const IMAGE_MODEL: ModelCaps = {
  modelId: IMAGE_MODEL_ID,
  label: "Muse Image (qua muse2api)",
  verified: true,
  modes: [],
  durations: { min: 0, max: 0, auto: false },
  aspectRatios: [...IMAGE_ASPECT_RATIOS],
  resolutions: [],
  defaultResolution: "",
  audio: false,
  negativePrompt: false,
  maxPromptChars: 2000,
  maxReferenceImages: 1,
  qualityModes: [],
  seed: false,
  notes: ["~40 giây/ảnh, ra WebP khoảng 1600px.", "4:5 có thể lệch tỷ lệ hơn các tỷ lệ còn lại.", "Tiêu hạn mức tuần của nick Muse."],
} as ModelCaps;

export interface ResolvedImageConfig {
  state: ImageConfigState;
  set: (patch: Partial<ImageConfigState>) => void;
  provider: ProviderConfig | null;
  usableProviders: ProviderConfig[];
  config: ImageBatchConfig | null;
  effectiveConcurrency: number;
  /** Cùng hình với ResolvedConfig của video để PromptSetPanel / AiGenerateForm / DeployDialog dùng chung */
  asResolved: ResolvedConfig;
}

function normalize(s: ImageConfigState, providers: ProviderConfig[]): ImageConfigState {
  const usable = providers.filter((p) => p.enabled && p.providerType === "muse2api");
  const provider = usable.find((p) => p.id === s.providerId) ?? usable.find((p) => p.status === "active") ?? usable[0];
  return {
    ...s,
    providerId: provider?.id ?? "",
    aspectRatio: (IMAGE_ASPECT_RATIOS as readonly string[]).includes(s.aspectRatio) ? s.aspectRatio : "1:1",
    variantsPerPrompt: Math.min(4, Math.max(1, Math.round(s.variantsPerPrompt) || 1)),
    referenceAssetIds: s.referenceAssetIds.slice(0, 1),
    maxConcurrency: Math.min(6, Math.max(1, Math.round(s.maxConcurrency) || 3)),
  };
}

export function useImageConfig(providers: ProviderConfig[]): ResolvedImageConfig {
  const [raw, setRaw] = useLocalStorage<ImageConfigState>("bvs.image.config", DEFAULT);
  const state = useMemo(() => normalize({ ...DEFAULT, ...raw }, providers), [raw, providers]);
  useEffect(() => {
    if (providers.length && JSON.stringify(state) !== JSON.stringify({ ...DEFAULT, ...raw })) setRaw(state);
  }, [state, raw, providers.length, setRaw]);

  const usableProviders = providers.filter((p) => p.enabled && p.providerType === "muse2api");
  const provider = usableProviders.find((p) => p.id === state.providerId) ?? null;
  const config: ImageBatchConfig | null = provider ? { aspectRatio: state.aspectRatio, variantsPerPrompt: state.variantsPerPrompt, referenceAssetIds: state.referenceAssetIds, maxAttempts: state.maxAttempts } : null;
  const set = (patch: Partial<ImageConfigState>) => setRaw((prev) => ({ ...DEFAULT, ...prev, ...patch }));
  const effectiveConcurrency = provider ? Math.max(1, Math.min(state.maxConcurrency, provider.maxConcurrency)) : state.maxConcurrency;

  const asResolved: ResolvedConfig = {
    state: {
      providerId: state.providerId,
      modelId: IMAGE_MODEL_ID,
      mode: "text-to-video",
      quality: null,
      durationSec: 0,
      aspectRatio: state.aspectRatio,
      resolution: "",
      audio: false,
      negative: "",
      variantsPerPrompt: state.variantsPerPrompt,
      maxConcurrency: state.maxConcurrency,
      budget: "",
      referenceAssetIds: state.referenceAssetIds,
      maxAttempts: state.maxAttempts,
    } satisfies VideoConfigState,
    set: (patch) => {
      const p: Partial<ImageConfigState> = {};
      if (patch.providerId !== undefined) p.providerId = patch.providerId;
      if (patch.aspectRatio !== undefined) p.aspectRatio = patch.aspectRatio;
      if (patch.variantsPerPrompt !== undefined) p.variantsPerPrompt = patch.variantsPerPrompt;
      if (patch.maxConcurrency !== undefined) p.maxConcurrency = patch.maxConcurrency;
      if (patch.referenceAssetIds !== undefined) p.referenceAssetIds = patch.referenceAssetIds;
      set(p);
    },
    provider,
    model: provider ? IMAGE_MODEL : null,
    usableProviders,
    config: config as unknown as ResolvedConfig["config"],
    budgetLimit: null,
    budgetInvalid: false,
    needsReferences: state.referenceAssetIds.length > 0,
    effectiveConcurrency,
  };
  return { state, set, provider, usableProviders, config, effectiveConcurrency, asResolved };
}
