import fs from "node:fs";
import { redact } from "../util.ts";
import {
  ProviderError,
  validateAgainstModel,
  type CostEstimate,
  type ErrorCategory,
  type GenerationInput,
  type ModelCapabilities,
  type ProviderCallContext,
  type ProviderCapabilities,
  type RemoteJobStatus,
  type ResolvedProviderConfig,
  type RetrievedResult,
  type ValidationIssue,
  type VideoProvider,
} from "./types.ts";

/**
 * Seedance qua BytePlus ModelArk (API chính thức, quốc tế).
 *
 * Đối chiếu tài liệu (đọc 2026-10-15, xem docs/providers/seedance-byteplus.md):
 *   POST   {endpoint}/contents/generations/tasks        → { id }
 *   GET    {endpoint}/contents/generations/tasks/{id}   → status queued|running|cancelled|succeeded|failed|expired,
 *                                                         content.video_url (hạn 24h), usage.completion_tokens, error{code,message}
 *   DELETE {endpoint}/contents/generations/tasks/{id}   → hủy task còn queued (running thì không hủy được)
 *   Xác thực: Authorization: Bearer <ARK API key>. Không có idempotency key trong tài liệu.
 *   callback_url: ModelArk POST trạng thái khi đổi (không có chữ ký) → server coi webhook chỉ là
 *   tín hiệu và GỌI LẠI GET để lấy trạng thái thật.
 *
 * CHƯA chạy với credentials thật (người dùng chưa có API key) - chỉ kiểm bằng
 * máy chủ giả lập theo đúng khuôn tài liệu trong test.
 */
export const DEFAULT_BYTEPLUS_ENDPOINT = "https://ark.ap-southeast.bytepluses.com/api/v3";

const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"];

const KNOWN_MODELS: ModelCapabilities[] = [
  {
    modelId: "dreamina-seedance-2-5-260628",
    label: "Dreamina Seedance 2.5",
    verified: true,
    modes: ["text-to-video", "image-to-video", "reference-to-video"],
    durations: { min: 4, max: 30, auto: true },
    aspectRatios: RATIOS,
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    audio: true,
    negativePrompt: false,
    maxPromptChars: 5000,
    maxReferenceImages: 30,
    qualityModes: [],
    seed: false,
    notes: [
      "1080p trả H.265/HEVC 10-bit - hệ thống tự tạo bản xem H.264 để phát trên trình duyệt, giữ nguyên file gốc.",
      "Tài liệu khuyến nghị prompt ≤ 1000 từ tiếng Anh; hỗ trợ prompt tiếng Việt.",
      "Không có negative prompt và seed trong tài liệu cho model này.",
    ],
  },
  {
    modelId: "dreamina-seedance-2-0-260128",
    label: "Dreamina Seedance 2.0",
    verified: true,
    modes: ["text-to-video", "image-to-video", "reference-to-video"],
    durations: { min: 4, max: 15, auto: true },
    aspectRatios: RATIOS,
    resolutions: ["480p", "720p", "1080p", "4k"],
    defaultResolution: "720p",
    audio: true,
    negativePrompt: false,
    maxPromptChars: 5000,
    maxReferenceImages: 9,
    qualityModes: [],
    seed: false,
    notes: ["Tối đa 15 giây mỗi video.", "Tài liệu: model 2.0 có mức token tối thiểu khi tính phí."],
  },
];

/** Model id người dùng tự thêm (chưa xác minh) - dùng giới hạn an toàn hẹp */
function unverifiedModel(modelId: string): ModelCapabilities {
  return {
    modelId,
    label: `${modelId} (chưa xác minh)`,
    verified: false,
    modes: ["text-to-video", "image-to-video"],
    durations: { min: 4, max: 12, auto: false },
    aspectRatios: ["16:9", "9:16", "1:1"],
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    audio: false,
    negativePrompt: false,
    maxPromptChars: 2000,
    maxReferenceImages: 1,
    qualityModes: [],
    seed: false,
    notes: ["Model id do bạn nhập, chưa đối chiếu tài liệu - hệ thống dùng giới hạn an toàn."],
  };
}

function modelsFor(config: ResolvedProviderConfig | null): ModelCapabilities[] {
  const ids = config?.modelIds?.length ? config.modelIds : KNOWN_MODELS.map((m) => m.modelId);
  return ids.map((id) => KNOWN_MODELS.find((m) => m.modelId === id) ?? unverifiedModel(id));
}

interface ArkTask {
  id: string;
  model?: string;
  status: "queued" | "running" | "cancelled" | "succeeded" | "failed" | "expired";
  content?: { video_url?: string; last_frame_url?: string } | null;
  error?: { code?: string; message?: string } | null;
  usage?: { completion_tokens?: number; total_tokens?: number } | null;
  duration?: number;
}

const CONTENT_POLICY_CODE = /sensitive|risk|policy|copyright|privacy/i;
const TRANSIENT_CODE = /internal|servererror|serviceunavailable|timeout|overload|busy/i;

export class SeedanceBytePlusProvider implements VideoProvider {
  readonly type = "seedance-byteplus";
  private fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  getCapabilities(config: ResolvedProviderConfig | null): ProviderCapabilities {
    return {
      providerType: this.type,
      label: "Seedance - BytePlus ModelArk",
      models: modelsFor(config),
      cancel: "queued_only",
      idempotency: false,
      progress: false,
      webhook: true,
      concurrencyHint: "Giới hạn RPM/đồng thời tùy loại tài khoản ModelArk - xem trang Model list trong console và đặt 'Số luồng tối đa' không vượt quota của bạn.",
      pricing: "user-configured",
      docsUrl: "https://docs.byteplus.com/en/docs/ModelArk/1520757",
    };
  }

  validateInput(input: GenerationInput, config: ResolvedProviderConfig): ValidationIssue[] {
    const issues = validateAgainstModel(input, this.getCapabilities(config));
    for (const ref of input.referenceImages) {
      if (!/^image\/(jpeg|png|webp)$/.test(ref.mime)) issues.push({ field: "referenceImages", code: "REFERENCE_FORMAT", message: `Ảnh tham chiếu ${ref.mime} chưa được hỗ trợ (dùng JPEG/PNG/WebP).` });
      try {
        if (fs.statSync(ref.path).size > 10 * 1024 * 1024) issues.push({ field: "referenceImages", code: "REFERENCE_TOO_LARGE", message: "Ảnh tham chiếu lớn hơn 10MB." });
      } catch {
        issues.push({ field: "referenceImages", code: "REFERENCE_MISSING", message: "Không đọc được file ảnh tham chiếu." });
      }
    }
    if (!config.apiKey) issues.push({ field: "provider", code: "PROVIDER_NOT_CONFIGURED", message: "Chưa nhập API key ModelArk cho provider này." });
    return issues;
  }

  /**
   * Giá CHỈ tính khi người dùng đã nhập đơn giá (options.pricePerSecond theo độ phân giải,
   * USD) - không tự bịa bảng giá. Thời lượng -1 (model tự chọn) → tính theo mức tối đa.
   */
  estimateCost(input: GenerationInput, config: ResolvedProviderConfig): CostEstimate {
    const table = (config.options?.pricePerSecond ?? {}) as Record<string, number>;
    const price = Number(table[input.resolution]);
    const model = modelsFor(config).find((m) => m.modelId === input.modelId);
    const seconds = input.durationSec === -1 ? (model?.durations.max ?? 0) : input.durationSec;
    if (!Number.isFinite(price) || price <= 0) {
      return { amount: null, currency: "USD", basis: `Chưa nhập đơn giá/giây cho ${input.resolution} - không ước tính được chi phí.`, kind: "unknown" };
    }
    return {
      amount: Math.round(seconds * price * 10000) / 10000,
      currency: String(config.options?.currency ?? "USD"),
      basis: `${seconds}s × ${price}/s (${input.resolution}, đơn giá bạn nhập)${input.durationSec === -1 ? " - thời lượng tự chọn, tính theo mức tối đa" : ""}`,
      kind: "user-configured",
    };
  }

  actualCost(usage: RemoteJobStatus["usage"], _input: GenerationInput, config: ResolvedProviderConfig): number | null {
    const perM = Number(config.options?.pricePerMillionTokens);
    if (!usage?.tokens || !Number.isFinite(perM) || perM <= 0) return null;
    return Math.round(((usage.tokens * perM) / 1_000_000) * 10000) / 10000;
  }

  private base(config: ResolvedProviderConfig): string {
    return (config.endpoint || DEFAULT_BYTEPLUS_ENDPOINT).replace(/\/+$/, "");
  }

  private async call<T>(ctx: ProviderCallContext, method: string, urlPath: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base(ctx.config)}${urlPath}`, {
        method,
        headers: { Authorization: `Bearer ${ctx.config.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctx.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; errors?: { code?: string }[] } };
      const code = err.cause?.code ?? err.cause?.errors?.[0]?.code ?? "";
      const unreachable = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(code);
      throw new ProviderError(unreachable ? "PROVIDER_UNAVAILABLE" : "TIMEOUT", redact(`Lỗi mạng khi gọi ModelArk: ${err.message}${code ? ` (${code})` : ""}`, [ctx.config.apiKey]), {
        provenNotSubmitted: unreachable,
      });
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const errObj = (json as { error?: { code?: string; message?: string } } | null)?.error ?? {};
      const code = errObj.code ?? "";
      const msg = errObj.message ?? text.slice(0, 300);
      let category: ErrorCategory;
      if (res.status === 401 || res.status === 403) category = "AUTH";
      else if (res.status === 429) category = /ratelimit|rpm|tpm|concurren/i.test(code) ? "RATE_LIMIT" : /quota|overdue|balance|insufficient/i.test(code) ? "QUOTA" : "RATE_LIMIT";
      else if (res.status === 402) category = "QUOTA";
      else if (res.status >= 500) category = "PROVIDER_UNAVAILABLE";
      else if (CONTENT_POLICY_CODE.test(code)) category = "CONTENT_POLICY";
      else category = "INVALID_INPUT";
      const retryAfter = Number(res.headers.get("retry-after"));
      // Che key ngay tại nguồn - thông điệp lỗi của provider có thể vọng lại header
      throw new ProviderError(category, redact(`ModelArk ${res.status} ${code}: ${msg}`, [ctx.config.apiKey]), {
        httpStatus: res.status,
        providerCode: code || null,
        retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        // Có phản hồi lỗi rõ ràng (4xx/429/5xx) = provider không tạo task
        provenNotSubmitted: true,
      });
    }
    return json as T;
  }

  buildRequestBody(input: GenerationInput, config: ResolvedProviderConfig): Record<string, unknown> {
    const content: Record<string, unknown>[] = [{ type: "text", text: input.prompt }];
    const role = input.mode === "reference-to-video" ? "reference_image" : "first_frame";
    for (const ref of input.referenceImages) {
      const b64 = fs.readFileSync(ref.path).toString("base64");
      content.push({ type: "image_url", image_url: { url: `data:${ref.mime};base64,${b64}` }, role });
    }
    const body: Record<string, unknown> = {
      model: input.modelId,
      content,
      ratio: input.aspectRatio,
      duration: input.durationSec,
      resolution: input.resolution,
      generate_audio: input.audio,
      watermark: Boolean(config.options?.watermark ?? false),
    };
    if (input.mode === "image-to-video" && input.referenceImages.length > 0) body.ratio = "adaptive";
    if (config.webhookUrl) body.callback_url = config.webhookUrl;
    return body;
  }

  async submitGeneration(input: GenerationInput, ctx: ProviderCallContext): Promise<{ remoteJobId: string }> {
    const body = this.buildRequestBody(input, ctx.config);
    const res = await this.call<{ id?: string }>(ctx, "POST", "/contents/generations/tasks", body);
    if (!res?.id) throw new ProviderError("INVALID_RESULT", "ModelArk không trả task id.");
    ctx.log(`[seedance] đã tạo task ${res.id}`);
    return { remoteJobId: res.id };
  }

  async getGenerationStatus(remoteJobId: string, ctx: ProviderCallContext): Promise<RemoteJobStatus> {
    const t = await this.call<ArkTask>(ctx, "GET", `/contents/generations/tasks/${encodeURIComponent(remoteJobId)}`);
    return mapArkTask(t);
  }

  async cancelGeneration(remoteJobId: string, ctx: ProviderCallContext): Promise<void> {
    await this.call(ctx, "DELETE", `/contents/generations/tasks/${encodeURIComponent(remoteJobId)}`);
  }

  async retrieveResult(remoteJobId: string, ctx: ProviderCallContext): Promise<RetrievedResult> {
    const t = await this.call<ArkTask>(ctx, "GET", `/contents/generations/tasks/${encodeURIComponent(remoteJobId)}`);
    const url = t.content?.video_url;
    if (t.status !== "succeeded" || !url) throw new ProviderError("INVALID_RESULT", `Task ${remoteJobId} chưa có video_url (status=${t.status}).`);
    return { url, mime: "video/mp4", expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() };
  }

  /** Kiểm key bằng List tasks (page_size=1) - không tạo video, không tốn credit */
  async testConnection(ctx: ProviderCallContext): Promise<{ ok: boolean; message: string }> {
    try {
      await this.call(ctx, "GET", "/contents/generations/tasks?page_num=1&page_size=1");
      return { ok: true, message: "Kết nối ModelArk được, API key hợp lệ." };
    } catch (e) {
      const pe = e as ProviderError;
      return { ok: false, message: redact(`${pe.category ?? "UNKNOWN"}: ${pe.message}`, [ctx.config.apiKey]) };
    }
  }
}

export function mapArkTask(t: ArkTask): RemoteJobStatus {
  const usage = t.usage ? { tokens: t.usage.completion_tokens ?? t.usage.total_tokens ?? null, durationSec: t.duration ?? null } : null;
  switch (t.status) {
    case "queued":
      return { status: "queued", progress: null };
    case "running":
      return { status: "processing", progress: null };
    case "succeeded":
      return { status: "completed", progress: 100, usage };
    case "cancelled":
      return { status: "cancelled", progress: null };
    case "expired":
      return { status: "failed", progress: null, error: { category: "TIMEOUT", message: "Task hết hạn ở ModelArk (expired).", providerCode: "expired", transient: false } };
    case "failed":
    default: {
      const code = t.error?.code ?? "";
      const category: ErrorCategory = CONTENT_POLICY_CODE.test(code) ? "CONTENT_POLICY" : "GENERATION_FAILED";
      return {
        status: "failed",
        progress: null,
        usage,
        error: { category, message: t.error?.message ?? "Tạo video thất bại.", providerCode: code || null, transient: category === "GENERATION_FAILED" && TRANSIENT_CODE.test(code) },
      };
    }
  }
}
