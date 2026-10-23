/**
 * Hợp đồng chung của mọi video provider. Pipeline/scheduler CHỈ biết interface
 * này - không bao giờ biết "Seedance" hay "Mock". Thêm provider = thêm một file
 * adapter + đăng ký ở registry.ts.
 */

export const ERROR_CATEGORIES = [
  "AUTH",
  "RATE_LIMIT",
  "QUOTA",
  "INVALID_INPUT",
  "CONTENT_POLICY",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "GENERATION_FAILED",
  "DOWNLOAD_FAILED",
  "INVALID_RESULT",
  "SUBMISSION_UNKNOWN",
  "UNKNOWN",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const ERROR_MESSAGES: Record<ErrorCategory, string> = {
  AUTH: "API key không hợp lệ hoặc tài khoản chưa có quyền dùng model này.",
  RATE_LIMIT: "Provider đang giới hạn tần suất yêu cầu.",
  QUOTA: "Đã hết quota hoặc hết credit ở provider.",
  INVALID_INPUT: "Provider từ chối thông số yêu cầu.",
  CONTENT_POLICY: "Provider từ chối nội dung prompt/ảnh theo chính sách - sửa prompt rồi tạo lại.",
  PROVIDER_UNAVAILABLE: "Provider tạm thời không khả dụng.",
  TIMEOUT: "Provider không phản hồi kịp.",
  GENERATION_FAILED: "Provider tạo video thất bại.",
  DOWNLOAD_FAILED: "Không tải được video kết quả về kho lưu trữ.",
  INVALID_RESULT: "File video provider trả về không hợp lệ.",
  SUBMISSION_UNKNOWN:
    "Không rõ provider đã nhận yêu cầu hay chưa (mất kết nối giữa lúc gửi). Hệ thống KHÔNG tự gửi lại để tránh tạo trùng/tính phí hai lần - kiểm tra trên trang quản lý của provider rồi bấm Tạo lại nếu chắc chắn chưa tạo.",
  UNKNOWN: "Lỗi không xác định từ provider.",
};

/** Lỗi nào được thử lại tự động (lỗi tạm thời) */
export const TRANSIENT_CATEGORIES: ErrorCategory[] = ["RATE_LIMIT", "PROVIDER_UNAVAILABLE", "TIMEOUT"];

export class ProviderError extends Error {
  category: ErrorCategory;
  retryAfterSec: number | null;
  httpStatus: number | null;
  providerCode: string | null;
  /** Lỗi tạo video (status failed) mà provider cho biết là tạm thời → được tạo lại */
  transient: boolean;
  /** Chứng minh được provider CHƯA tạo job (từ chối trả lời / không nối được) */
  provenNotSubmitted: boolean;
  constructor(
    category: ErrorCategory,
    message: string,
    opts: { retryAfterSec?: number | null; httpStatus?: number | null; providerCode?: string | null; transient?: boolean; provenNotSubmitted?: boolean } = {},
  ) {
    super(message);
    this.category = category;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.httpStatus = opts.httpStatus ?? null;
    this.providerCode = opts.providerCode ?? null;
    this.transient = opts.transient ?? TRANSIENT_CATEGORIES.includes(category);
    this.provenNotSubmitted = opts.provenNotSubmitted ?? false;
  }
}

export type GenerationMode = "text-to-video" | "image-to-video" | "reference-to-video";

export interface ModelCapabilities {
  modelId: string;
  label: string;
  /** true = thông số lấy từ tài liệu chính thức đã đọc; false = model id người dùng tự thêm, dùng giới hạn an toàn */
  verified: boolean;
  modes: GenerationMode[];
  durations: { min: number; max: number; auto: boolean };
  aspectRatios: string[];
  resolutions: string[];
  defaultResolution: string;
  audio: boolean;
  negativePrompt: boolean;
  maxPromptChars: number;
  maxReferenceImages: number;
  /** Chế độ Nhanh / Chất lượng cao - CHỈ khai khi provider thật sự có */
  qualityModes: string[];
  seed: boolean;
  notes: string[];
}

export interface ProviderCapabilities {
  providerType: string;
  label: string;
  models: ModelCapabilities[];
  /** Hủy job ở phía provider: none | queued_only (chỉ khi còn xếp hàng) | any */
  cancel: "none" | "queued_only" | "any";
  /** Gửi lại cùng idempotency key không tạo job thứ hai */
  idempotency: boolean;
  /** getStatus trả % thật */
  progress: boolean;
  webhook: boolean;
  /** Giới hạn đồng thời theo tài liệu (gợi ý) - giới hạn thật do người dùng đặt theo quota tài khoản */
  concurrencyHint: string | null;
  pricing: "free-mock" | "user-configured" | "unknown";
  docsUrl: string | null;
}

export interface GenerationInput {
  modelId: string;
  mode: GenerationMode;
  prompt: string;
  negativePrompt?: string | null;
  /** -1 = để model tự chọn (chỉ khi model hỗ trợ auto) */
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  quality?: string | null;
  seed?: number | null;
  referenceImages: { path: string; mime: string }[];
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface CostEstimate {
  /** null = không xác định được (chưa có đơn giá đáng tin cậy) */
  amount: number | null;
  currency: string;
  basis: string;
  kind: "free-mock" | "user-configured" | "unknown";
}

export interface ResolvedProviderConfig {
  id: string;
  workspaceId: string;
  providerType: string;
  name: string;
  endpoint: string;
  modelIds: string[];
  defaultModelId: string | null;
  maxConcurrency: number;
  requestsPerMinute: number;
  options: Record<string, unknown>;
  /** Secret đã giải mã - CHỈ tồn tại trong bộ nhớ server */
  apiKey: string;
  webhookUrl: string | null;
}

export interface ProviderCallContext {
  config: ResolvedProviderConfig;
  idempotencyKey: string;
  /** Thư mục tạm riêng để provider đặt file kết quả (mock) */
  workDir: string;
  signal?: AbortSignal;
  log(line: string): void;
}

export type RemoteStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface RemoteJobStatus {
  status: RemoteStatus;
  progress: number | null;
  error?: { category: ErrorCategory; message: string; providerCode?: string | null; transient?: boolean } | null;
  usage?: { tokens?: number | null; durationSec?: number | null } | null;
}

export interface RetrievedResult {
  /** URL tải (thường là signed URL ngắn hạn - KHÔNG được lưu làm tài sản) */
  url?: string;
  /** Hoặc file có sẵn trên máy (mock) */
  filePath?: string;
  mime: string;
  expiresAt?: string | null;
}

export interface VideoProvider {
  readonly type: string;
  getCapabilities(config: ResolvedProviderConfig | null): ProviderCapabilities;
  validateInput(input: GenerationInput, config: ResolvedProviderConfig): ValidationIssue[];
  estimateCost(input: GenerationInput, config: ResolvedProviderConfig): CostEstimate;
  submitGeneration(input: GenerationInput, ctx: ProviderCallContext): Promise<{ remoteJobId: string }>;
  getGenerationStatus(remoteJobId: string, ctx: ProviderCallContext): Promise<RemoteJobStatus>;
  cancelGeneration?(remoteJobId: string, ctx: ProviderCallContext): Promise<void>;
  retrieveResult(remoteJobId: string, ctx: ProviderCallContext): Promise<RetrievedResult>;
  /** Kiểm key - KHÔNG tạo video, KHÔNG tiêu credit */
  testConnection?(ctx: ProviderCallContext): Promise<{ ok: boolean; message: string }>;
  /** Thông số actual cost từ usage provider trả về */
  actualCost?(usage: RemoteJobStatus["usage"], input: GenerationInput, config: ResolvedProviderConfig): number | null;
}

/** Kiểm chung theo capabilities - adapter gọi rồi thêm luật riêng */
export function validateAgainstModel(input: GenerationInput, caps: ProviderCapabilities): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const m = caps.models.find((x) => x.modelId === input.modelId);
  if (!m) {
    issues.push({ field: "modelId", code: "MODEL_NOT_AVAILABLE", message: `Model "${input.modelId}" không có trong cấu hình provider này.` });
    return issues;
  }
  const p = input.prompt?.trim() ?? "";
  if (!p) issues.push({ field: "prompt", code: "EMPTY_PROMPT", message: "Prompt trống." });
  if (p.length > m.maxPromptChars) issues.push({ field: "prompt", code: "PROMPT_TOO_LONG", message: `Prompt dài ${p.length} ký tự, model ${m.label} cho tối đa ${m.maxPromptChars}.` });
  if (!m.modes.includes(input.mode)) issues.push({ field: "mode", code: "MODE_UNSUPPORTED", message: `Model ${m.label} không hỗ trợ chế độ ${input.mode}.` });
  if (input.durationSec === -1) {
    if (!m.durations.auto) issues.push({ field: "durationSec", code: "DURATION_UNSUPPORTED", message: `Model ${m.label} không cho để model tự chọn thời lượng.` });
  } else if (!Number.isInteger(input.durationSec) || input.durationSec < m.durations.min || input.durationSec > m.durations.max) {
    issues.push({
      field: "durationSec",
      code: "DURATION_UNSUPPORTED",
      message: `Model ${m.label} chỉ tạo được ${m.durations.min}-${m.durations.max} giây, yêu cầu ${input.durationSec} giây. Chọn thời lượng khác hoặc model khác.`,
    });
  }
  if (!m.aspectRatios.includes(input.aspectRatio)) issues.push({ field: "aspectRatio", code: "ASPECT_UNSUPPORTED", message: `Model ${m.label} không hỗ trợ tỷ lệ ${input.aspectRatio}.` });
  if (!m.resolutions.includes(input.resolution)) issues.push({ field: "resolution", code: "RESOLUTION_UNSUPPORTED", message: `Model ${m.label} không hỗ trợ độ phân giải ${input.resolution}.` });
  if (input.audio && !m.audio) issues.push({ field: "audio", code: "AUDIO_UNSUPPORTED", message: `Model ${m.label} không tạo được âm thanh.` });
  if (input.negativePrompt && input.negativePrompt.trim() && !m.negativePrompt)
    issues.push({ field: "negativePrompt", code: "NEGATIVE_UNSUPPORTED", message: `Model ${m.label} không nhận negative prompt - bỏ trống hoặc đưa ràng buộc vào prompt chính.` });
  if (input.quality && !m.qualityModes.includes(input.quality)) issues.push({ field: "quality", code: "QUALITY_UNSUPPORTED", message: `Model ${m.label} không có chế độ "${input.quality}".` });
  if (input.referenceImages.length > m.maxReferenceImages)
    issues.push({ field: "referenceImages", code: "TOO_MANY_REFERENCES", message: `Model ${m.label} nhận tối đa ${m.maxReferenceImages} ảnh tham chiếu.` });
  if ((input.mode === "image-to-video" || input.mode === "reference-to-video") && input.referenceImages.length === 0)
    issues.push({ field: "referenceImages", code: "REFERENCE_REQUIRED", message: "Chế độ này cần ít nhất một ảnh tham chiếu." });
  if (input.seed !== undefined && input.seed !== null && !m.seed) issues.push({ field: "seed", code: "SEED_UNSUPPORTED", message: `Model ${m.label} không nhận seed.` });
  return issues;
}

// ---------------------------------------------------------------- ẢNH
// Tạo ảnh hàng loạt dùng chung hàng đợi/scheduler với video; provider nào làm được ảnh thì
// khai thêm interface tuỳ chọn này (KHÔNG đụng ProviderCapabilities để video giữ nguyên).

export const IMAGE_ASPECT_RATIOS = ["1:1", "4:5", "9:16", "16:9", "3:4"] as const;
export const IMAGE_MAX_VARIANTS = 4;
export const IMAGE_CONCURRENCY = { min: 1, max: 6, default: 3 } as const;
/** Từ bằng này ảnh trở lên bắt buộc xác nhận riêng trước khi chạy */
export const IMAGE_CONFIRM_THRESHOLD = 30;
export const IMAGE_MODEL_ID = "muse-image";

export interface ImageGenerationInput {
  modelId: string;
  prompt: string;
  aspectRatio: string;
  referenceImages: { path: string; mime: string }[];
}

export interface ImageModelCaps {
  modelId: string;
  label: string;
  aspectRatios: string[];
  maxReferenceImages: number;
  maxPromptChars: number;
  notes: string[];
}

export interface ImageCapableProvider {
  /** Gửi lại cùng Idempotency-Key không tạo ảnh thứ hai */
  readonly imageIdempotency: boolean;
  getImageModel(config: ResolvedProviderConfig | null): ImageModelCaps;
  validateImageInput(input: ImageGenerationInput, config: ResolvedProviderConfig): ValidationIssue[];
  submitImage(input: ImageGenerationInput, ctx: ProviderCallContext): Promise<{ remoteJobId: string }>;
  getImageStatus(remoteJobId: string, ctx: ProviderCallContext): Promise<RemoteJobStatus>;
  retrieveImage(remoteJobId: string, ctx: ProviderCallContext): Promise<RetrievedResult>;
}

export function isImageCapable(adapter: unknown): adapter is ImageCapableProvider & VideoProvider {
  const a = adapter as Partial<ImageCapableProvider> | null;
  return Boolean(a && typeof a.submitImage === "function" && typeof a.getImageStatus === "function" && typeof a.retrieveImage === "function");
}
