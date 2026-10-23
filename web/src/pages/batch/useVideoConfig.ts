import { useEffect, useMemo } from "react";
import type { BatchConfig, GenerationMode, ModelCaps, ProviderConfig } from "../../api";
import { useLocalStorage } from "../../hooks/useApi";

export interface VideoConfigState {
  providerId: string;
  modelId: string;
  mode: GenerationMode;
  quality: string | null;
  /** -1 = model tự chọn */
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  negative: string;
  variantsPerPrompt: number;
  maxConcurrency: number;
  /** chuỗi để giữ ô trống = không đặt ngân sách */
  budget: string;
  referenceAssetIds: string[];
  maxAttempts: number;
}

const DEFAULT: VideoConfigState = {
  providerId: "",
  modelId: "",
  mode: "text-to-video",
  quality: null,
  durationSec: 30,
  aspectRatio: "9:16",
  resolution: "720p",
  audio: false,
  negative: "",
  variantsPerPrompt: 1,
  maxConcurrency: 2,
  budget: "",
  referenceAssetIds: [],
  maxAttempts: 3,
};

export const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 16, 20, 30];

export interface ResolvedConfig {
  state: VideoConfigState;
  set: (patch: Partial<VideoConfigState>) => void;
  provider: ProviderConfig | null;
  model: ModelCaps | null;
  usableProviders: ProviderConfig[];
  /** Cấu hình gửi API (đã lọc theo khả năng model) */
  config: BatchConfig | null;
  budgetLimit: number | null;
  budgetInvalid: boolean;
  needsReferences: boolean;
  effectiveConcurrency: number;
}

/** Chuẩn hóa cấu hình theo khả năng THẬT của provider/model (không hiện tùy chọn model không có) */
function normalize(s: VideoConfigState, providers: ProviderConfig[]): VideoConfigState {
  const usable = providers.filter((p) => p.enabled);
  if (!usable.length) return s;
  const provider = usable.find((p) => p.id === s.providerId) ?? usable.find((p) => p.status === "active" && p.providerType !== "mock") ?? usable.find((p) => p.status === "active") ?? usable[0]!;
  const models = provider.capabilities.models;
  const model = models.find((m) => m.modelId === s.modelId) ?? models.find((m) => m.modelId === provider.defaultModelId) ?? models[0];
  if (!model) return { ...s, providerId: provider.id, modelId: "" };
  const mode = model.modes.includes(s.mode) ? s.mode : (model.modes[0] ?? "text-to-video");
  const quality = model.qualityModes.length ? (s.quality && model.qualityModes.includes(s.quality) ? s.quality : model.qualityModes[0]!) : null;
  let durationSec = s.durationSec;
  if (durationSec === -1 && !model.durations.auto) durationSec = Math.min(model.durations.max, Math.max(model.durations.min, 30));
  if (durationSec !== -1) durationSec = Math.min(model.durations.max, Math.max(model.durations.min, Math.round(durationSec) || model.durations.min));
  const aspectRatio = model.aspectRatios.includes(s.aspectRatio) ? s.aspectRatio : model.aspectRatios.includes("9:16") ? "9:16" : (model.aspectRatios[0] ?? s.aspectRatio);
  const resolution = model.resolutions.includes(s.resolution) ? s.resolution : model.resolutions.includes(model.defaultResolution) ? model.defaultResolution : (model.resolutions[0] ?? s.resolution);
  const audio = model.audio ? s.audio : false;
  const referenceAssetIds = s.referenceAssetIds.slice(0, Math.max(0, model.maxReferenceImages));
  const variantsPerPrompt = Math.min(10, Math.max(1, Math.round(s.variantsPerPrompt) || 1));
  const maxConcurrency = CONCURRENCY_OPTIONS.includes(s.maxConcurrency) ? s.maxConcurrency : Math.min(provider.maxConcurrency, 30) || 2;
  return { ...s, providerId: provider.id, modelId: model.modelId, mode, quality, durationSec, aspectRatio, resolution, audio, referenceAssetIds, variantsPerPrompt, maxConcurrency };
}

function same(a: VideoConfigState, b: VideoConfigState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useVideoConfig(providers: ProviderConfig[]): ResolvedConfig {
  const [raw, setRaw] = useLocalStorage<VideoConfigState>("bvs.batch.config", DEFAULT);
  const state = useMemo(() => normalize({ ...DEFAULT, ...raw }, providers), [raw, providers]);
  useEffect(() => {
    if (providers.length && !same(state, { ...DEFAULT, ...raw })) setRaw(state);
  }, [state, raw, providers.length, setRaw]);

  const usableProviders = providers.filter((p) => p.enabled);
  const provider = usableProviders.find((p) => p.id === state.providerId) ?? null;
  const model = provider?.capabilities.models.find((m) => m.modelId === state.modelId) ?? null;
  const needsReferences = state.mode !== "text-to-video";
  const budgetTrim = state.budget.trim().replace(",", ".");
  const budgetNum = budgetTrim ? Number(budgetTrim) : null;
  const budgetInvalid = budgetNum !== null && (!Number.isFinite(budgetNum) || budgetNum < 0);
  const config: BatchConfig | null =
    provider && model
      ? {
          mode: state.mode,
          durationSec: state.durationSec,
          aspectRatio: state.aspectRatio,
          resolution: state.resolution,
          audio: model.audio ? state.audio : false,
          quality: model.qualityModes.length ? state.quality : null,
          variantsPerPrompt: state.variantsPerPrompt,
          referenceAssetIds: needsReferences ? state.referenceAssetIds : [],
          maxAttempts: state.maxAttempts,
        }
      : null;

  return {
    state,
    set: (patch) => setRaw((prev) => ({ ...DEFAULT, ...prev, ...patch })),
    provider,
    model,
    usableProviders,
    config,
    budgetLimit: budgetInvalid ? null : budgetNum,
    budgetInvalid,
    needsReferences,
    effectiveConcurrency: provider ? Math.max(1, Math.min(state.maxConcurrency, provider.maxConcurrency)) : state.maxConcurrency,
  };
}
