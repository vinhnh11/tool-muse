import fs from "node:fs";
import { redact } from "../util.ts";
import {
  ProviderError,
  validateAgainstModel,
  type CostEstimate,
  type ErrorCategory,
  type GenerationInput,
  type ImageCapableProvider,
  type ImageGenerationInput,
  type ImageModelCaps,
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODEL_ID,
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
 * muse2api - cổng OpenAI-compatible bọc web muse.ai (dự án mã nguồn mở
 * github.com/czg86389-hub/muse2api, chạy như service RIÊNG, mặc định
 * http://127.0.0.1:18610).
 *
 * Đối chiếu MÃ NGUỒN app.py (đọc 2026-10-16, KHÔNG chỉ dựa README):
 *   POST {endpoint}/v1/videos            body VideoRequest {prompt, model, duration, size,
 *                                        aspect_ratio, resolution, timeout, extra, reference_image}
 *                                        → { id, task_id, status:"queued", progress:10 }
 *   GET  {endpoint}/v1/videos/{task_id}  → { status: queued|processing|completed|failed,
 *                                        progress:int, url?, video:{url}?, result:{url,filename,bytes,kind}?, error? }
 *   GET  {endpoint}/v1/media/{name}      → file MP4. KHÔNG yêu cầu Authorization (xác nhận trong
 *                                        get_media: không có Depends(auth)) → BVS tải trực tiếp được.
 *   GET  {endpoint}/v1/models            → cần Bearer; dùng để kiểm key mà KHÔNG tiêu quota.
 *   GET  {endpoint}/readyz               → {status: ready|no_account, accounts, browser_running} (không cần key).
 *   Xác thực: header Authorization kiểu Bearer với MUSE2API_KEY. Bỏ trống key ở server thì mọi request được nhận.
 *
 * KHÔNG có endpoint hủy video và KHÔNG có idempotency cho video (Idempotency-Key chỉ
 * áp dụng cho /v1/images/tasks) → khai cancel:"none", idempotency:false để scheduler
 * không bao giờ gửi lại cùng key (tránh tạo trùng, tiêu quota hai lần).
 *
 * TÍNH PHÍ: không trả tiền theo request, nhưng TIÊU QUOTA tài khoản Muse của người dùng
 * → pricing "unknown" (KHÔNG phải "free-mock"). Nhờ vậy BVS vẫn buộc người dùng bấm
 * duyệt, và trợ lý/agent không được tự chạy.
 *
 * CHƯA chạy với muse2api thật (cần tài khoản Muse) - adapter được kiểm bằng máy chủ
 * giả lập dựng đúng theo app.py ở server/test/muse2api.test.ts.
 */
export const DEFAULT_MUSE2API_ENDPOINT = "http://127.0.0.1:18610";

/** build_video_prompt chỉ nhận dọc/ngang; tỷ lệ khác bị diễn giải mơ hồ → chỉ khai 2 cái chắc chắn */
const RATIOS = ["9:16", "16:9"];

/** app.py: duration mặc định 6; Muse nhận video tới 30 giây */
const DURATIONS = [5, 6, 8, 10, 15, 30];
const MIN_SEC = 3;
const MAX_SEC = 30;

export { durationFromPrompt } from "../util.ts";
import { durationFromPrompt } from "../util.ts";

const MUSE_VIDEO: ModelCapabilities = {
  modelId: "muse-video",
  label: "Muse Video (qua muse2api)",
  verified: true,
  modes: ["text-to-video", "image-to-video"],
  durations: { min: MIN_SEC, max: MAX_SEC, auto: true },
  aspectRatios: RATIOS,
  resolutions: ["720p"],
  defaultResolution: "720p",
  audio: false,
  negativePrompt: false,
  maxPromptChars: 2000,
  maxReferenceImages: 1,
  qualityModes: [],
  seed: false,
  notes: [
    `Thời lượng ${MIN_SEC}-${MAX_SEC} giây. Nếu prompt ghi rõ (vd "dài 12 giây") thì NGHE THEO PROMPT, không thì theo cấu hình. Thành phẩm do Muse quyết định, có thể lệch.`,
    "Chỉ 9:16 hoặc 16:9 - muse2api ghép yêu cầu tỷ lệ vào prompt chứ không có tham số riêng.",
    "image-to-video dùng ảnh làm KHUNG ĐẦU (first frame), tối đa 1 ảnh.",
    "Không có negative prompt, không chọn seed, không điều khiển âm thanh.",
    "Tiêu quota tài khoản Muse (hạn mức tuần + token bổ sung), không tính tiền theo request.",
    "Không hủy được job đã gửi: muse2api không có endpoint hủy video.",
  ],
};

const MUSE_IMAGE: ImageModelCaps = {
  modelId: IMAGE_MODEL_ID,
  label: "Muse Image (qua muse2api)",
  aspectRatios: [...IMAGE_ASPECT_RATIOS],
  maxReferenceImages: 1,
  maxPromptChars: 2000,
  notes: [
    "~40 giây/ảnh, ra WebP khoảng 1600px.",
    "4:5 không có nhánh riêng trong muse2api nên có thể lệch tỷ lệ hơn các tỷ lệ còn lại.",
    "Tiêu hạn mức tuần của nick Muse. Không hủy được ảnh đã gửi.",
  ],
};

function unverifiedModel(modelId: string): ModelCapabilities {
  return {
    ...MUSE_VIDEO,
    modelId,
    label: `${modelId} (chưa xác minh)`,
    verified: false,
    notes: ["Model id do bạn nhập, không có trong danh sách muse2api - hệ thống dùng giới hạn an toàn của muse-video."],
  };
}

function modelsFor(config: ResolvedProviderConfig | null): ModelCapabilities[] {
  const ids = config?.modelIds?.length ? config.modelIds : [MUSE_VIDEO.modelId];
  return ids.map((id) => (id === MUSE_VIDEO.modelId ? MUSE_VIDEO : unverifiedModel(id)));
}

/** Dạng task muse2api trả về (app.py: get_video trả nguyên dict task + chuẩn hoá status/progress) */
interface MuseTask {
  id?: string;
  task_id?: string;
  status?: string;
  progress?: number | null;
  url?: string | null;
  video?: { url?: string } | null;
  result?: { url?: string; filename?: string; bytes?: number; kind?: string } | null;
  error?: string | null;
  account?: string | null;
  elapsed?: number | null;
}

/** Thông điệp lỗi do engine.py ném ra, phân loại để scheduler xử lý đúng */
const AUTH_MSG = /cookie|đăng nhập|认证|401|unauthor|auth|session/i;
const QUOTA_MSG = /quota|hạn mức|额度|credit|限额|exhaust|用完/i;
const POLICY_MSG = /policy|từ chối|拒答|拒绝|refuse|not allowed|vi phạm/i;
const TRANSIENT_MSG = /timeout|超时|chờ|busy|忙|đang|unavailable|不可用|connect|网络|network|队列|queue full|重试|retry/i;

export class Muse2ApiProvider implements VideoProvider, ImageCapableProvider {
  readonly type = "muse2api";
  /** POST /v1/images/tasks nhận header Idempotency-Key: cùng key + cùng body → trả lại task cũ */
  readonly imageIdempotency = true;
  private fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  getCapabilities(config: ResolvedProviderConfig | null): ProviderCapabilities {
    return {
      providerType: this.type,
      label: "Muse (qua muse2api)",
      models: modelsFor(config),
      // app.py không có route hủy video
      cancel: "none",
      // Idempotency-Key chỉ có ở /v1/images/tasks, video thì không
      idempotency: false,
      // get_video trả progress thật (10 → 15 → ... → 100)
      progress: true,
      webhook: false,
      concurrencyHint:
        "muse2api chạy Chromium thật: mặc định MUSE2API_CONCURRENCY=2. Đặt 'Số luồng tối đa' ≤ số đó và ≤ số tài khoản Muse trong pool, nếu không job chỉ xếp hàng bên muse2api.",
      // Không trả tiền theo request NHƯNG tiêu quota tài khoản Muse → không bao giờ khai free-mock
      pricing: "unknown",
      docsUrl: "https://github.com/czg86389-hub/muse2api",
    };
  }

  validateInput(input: GenerationInput, config: ResolvedProviderConfig): ValidationIssue[] {
    const issues = validateAgainstModel(input, this.getCapabilities(config));
    // Thời lượng là tập rời rạc, validateAgainstModel chỉ kiểm khoảng min-max
    // Thời lượng: prompt có ghi "dài N giây" thì theo prompt; không thì theo cấu hình (số nguyên MIN-MAX)
    for (const ref of input.referenceImages) {
      if (!/^image\/(jpeg|png|webp)$/.test(ref.mime))
        issues.push({ field: "referenceImages", code: "REFERENCE_FORMAT", message: `Ảnh tham chiếu ${ref.mime} chưa được hỗ trợ (dùng JPEG/PNG/WebP).` });
      try {
        if (fs.statSync(ref.path).size > 10 * 1024 * 1024) issues.push({ field: "referenceImages", code: "REFERENCE_TOO_LARGE", message: "Ảnh tham chiếu lớn hơn 10MB." });
      } catch {
        issues.push({ field: "referenceImages", code: "REFERENCE_MISSING", message: "Không đọc được file ảnh tham chiếu." });
      }
    }
    if (!config.endpoint?.trim()) issues.push({ field: "provider", code: "PROVIDER_NOT_CONFIGURED", message: "Chưa nhập địa chỉ muse2api (vd http://127.0.0.1:18610)." });
    return issues;
  }

  /**
   * Không có giá theo request: muse2api dùng hạn mức tài khoản Muse. Trả "unknown"
   * để BVS hiển thị "không xác định" và vẫn bắt người dùng xác nhận trước khi chạy.
   */
  estimateCost(_input: GenerationInput, _config: ResolvedProviderConfig): CostEstimate {
    return {
      amount: null,
      currency: "USD",
      basis: "muse2api không tính tiền theo request - mỗi video TIÊU HẠN MỨC tài khoản Muse. Theo dõi hạn mức ở trang quản trị muse2api.",
      kind: "unknown",
    };
  }

  private base(config: ResolvedProviderConfig): string {
    return (config.endpoint || DEFAULT_MUSE2API_ENDPOINT).replace(/\/+$/, "");
  }

  private async call<T>(ctx: ProviderCallContext, method: string, urlPath: string, body?: unknown, timeoutMs = 60_000, extraHeaders: Record<string, string> = {}): Promise<T> {
    // muse2api chạy browser thật nên có thể chậm; cho người dùng nới hạn chờ mỗi request
    const confTimeout = Number(ctx.config.options?.requestTimeoutMs);
    const effTimeout = Number.isFinite(confTimeout) && confTimeout > 0 ? confTimeout : timeoutMs;
    const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
    // Server bỏ trống MUSE2API_KEY thì không cần header; có key thì bắt buộc Bearer
    if (ctx.config.apiKey) headers.Authorization = `Bearer ${ctx.config.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base(ctx.config)}${urlPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctx.signal ?? AbortSignal.timeout(effTimeout),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string; errors?: { code?: string }[] } };
      const code = err.cause?.code ?? err.cause?.errors?.[0]?.code ?? "";
      // Hết thời gian chờ = request CÓ THỂ đã tới server → không được kết luận là chưa gửi
      const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
      // Không thiết lập nổi kết nối (bao gồm cổng không hợp lệ: undici trả cause.message "bad port"
      // mà KHÔNG có cause.code) → chắc chắn chưa gửi, scheduler được phép tạo lại
      const unreachable =
        !timedOut &&
        (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ERR_INVALID_URL"].includes(code) ||
          /bad port|invalid url|failed to parse/i.test(err.cause?.message ?? ""));
      const detail = code || err.cause?.message || "";
      throw new ProviderError(
        unreachable ? "PROVIDER_UNAVAILABLE" : "TIMEOUT",
        redact(`Không gọi được muse2api: ${err.message}${detail ? ` (${detail})` : ""}${unreachable ? " - kiểm tra địa chỉ và xem service muse2api còn chạy không." : ""}`, [ctx.config.apiKey]),
        { provenNotSubmitted: unreachable },
      );
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      // FastAPI trả {"detail": "..."}
      const detail = (json as { detail?: unknown } | null)?.detail;
      const msg = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : text.slice(0, 300);
      let category: ErrorCategory;
      if (res.status === 401 || res.status === 403) category = "AUTH";
      else if (res.status === 429) category = "RATE_LIMIT";
      else if (res.status === 404) category = "INVALID_INPUT";
      else if (res.status >= 500) category = "PROVIDER_UNAVAILABLE";
      else category = "INVALID_INPUT";
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ProviderError(category, redact(`muse2api ${res.status}: ${msg}`, [ctx.config.apiKey]), {
        httpStatus: res.status,
        retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        // Có phản hồi lỗi rõ ràng = server chưa nhận task
        provenNotSubmitted: true,
      });
    }
    return json as T;
  }

  /** VideoRequest của app.py: ảnh tham chiếu truyền bằng Data URL qua reference_image */
  buildRequestBody(input: GenerationInput, config: ResolvedProviderConfig): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: input.modelId,
      prompt: input.prompt,
      duration: durationFromPrompt(input.prompt) ?? (input.durationSec === -1 ? 8 : input.durationSec),
      aspect_ratio: input.aspectRatio,
      size: input.aspectRatio,
      resolution: input.resolution,
    };
    const ref = input.referenceImages[0];
    if (ref) {
      const b64 = fs.readFileSync(ref.path).toString("base64");
      body.reference_image = `data:${ref.mime};base64,${b64}`;
    }
    // Cho phép người dùng nối thêm chỉ dẫn cố định cho mọi video (options.extraPrompt)
    const extra = config.options?.extraPrompt;
    if (typeof extra === "string" && extra.trim()) body.extra = extra.trim();
    // Hẹn giờ phía muse2api: để nó tự bỏ job treo thay vì treo mãi
    const t = Number(config.options?.videoTimeoutSec);
    if (Number.isFinite(t) && t > 0) body.timeout = Math.round(t);
    return body;
  }

  async submitGeneration(input: GenerationInput, ctx: ProviderCallContext): Promise<{ remoteJobId: string }> {
    const res = await this.call<MuseTask>(ctx, "POST", "/v1/videos", this.buildRequestBody(input, ctx.config));
    const id = res?.id ?? res?.task_id;
    if (!id) throw new ProviderError("INVALID_RESULT", "muse2api không trả task id.");
    ctx.log(`[muse2api] đã tạo task ${id}`);
    return { remoteJobId: String(id) };
  }

  async getGenerationStatus(remoteJobId: string, ctx: ProviderCallContext): Promise<RemoteJobStatus> {
    const t = await this.call<MuseTask>(ctx, "GET", `/v1/videos/${encodeURIComponent(remoteJobId)}`);
    return mapMuseTask(t);
  }

  async retrieveResult(remoteJobId: string, ctx: ProviderCallContext): Promise<RetrievedResult> {
    const t = await this.call<MuseTask>(ctx, "GET", `/v1/videos/${encodeURIComponent(remoteJobId)}`);
    const raw = t.url ?? t.video?.url ?? t.result?.url ?? "";
    if (mapMuseTask(t).status !== "completed" || !raw) throw new ProviderError("INVALID_RESULT", `Task ${remoteJobId} chưa có link video (status=${t.status ?? "?"}).`);
    // media_url() trả đường dẫn TƯƠNG ĐỐI khi MUSE2API_PUBLIC_BASE trống → tự ghép base
    const url = this.absoluteUrl(ctx.config, raw);
    // /v1/media/{name} không đòi Authorization nên tải trực tiếp được; file nằm trên đĩa, không hết hạn
    return { url, mime: "video/mp4", expiresAt: null };
  }

  private absoluteUrl(config: ResolvedProviderConfig, raw: string): string {
    return /^https?:\/\//i.test(raw) ? raw : `${this.base(config)}${raw.startsWith("/") ? "" : "/"}${raw}`;
  }

  // ------------------------------------------------------------ ẢNH (POST /v1/images/tasks)

  getImageModel(_config: ResolvedProviderConfig | null): ImageModelCaps {
    return MUSE_IMAGE;
  }

  validateImageInput(input: ImageGenerationInput, config: ResolvedProviderConfig): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const p = input.prompt?.trim() ?? "";
    if (!p) issues.push({ field: "prompt", code: "EMPTY_PROMPT", message: "Prompt trống." });
    if (p.length > MUSE_IMAGE.maxPromptChars) issues.push({ field: "prompt", code: "PROMPT_TOO_LONG", message: `Prompt dài ${p.length} ký tự, tạo ảnh cho tối đa ${MUSE_IMAGE.maxPromptChars}.` });
    if (!MUSE_IMAGE.aspectRatios.includes(input.aspectRatio)) issues.push({ field: "aspectRatio", code: "ASPECT_UNSUPPORTED", message: `Tạo ảnh không hỗ trợ tỷ lệ ${input.aspectRatio} (chọn ${MUSE_IMAGE.aspectRatios.join(", ")}).` });
    if (input.referenceImages.length > MUSE_IMAGE.maxReferenceImages) issues.push({ field: "referenceImages", code: "TOO_MANY_REFERENCES", message: `Tạo ảnh nhận tối đa ${MUSE_IMAGE.maxReferenceImages} ảnh tham chiếu.` });
    for (const ref of input.referenceImages) {
      if (!/^image\/(jpeg|png|webp)$/.test(ref.mime)) issues.push({ field: "referenceImages", code: "REFERENCE_FORMAT", message: `Ảnh tham chiếu ${ref.mime} chưa được hỗ trợ (dùng JPEG/PNG/WebP).` });
      try {
        if (fs.statSync(ref.path).size > 10 * 1024 * 1024) issues.push({ field: "referenceImages", code: "REFERENCE_TOO_LARGE", message: "Ảnh tham chiếu lớn hơn 10MB." });
      } catch {
        issues.push({ field: "referenceImages", code: "REFERENCE_MISSING", message: "Không đọc được file ảnh tham chiếu." });
      }
    }
    if (!config.endpoint?.trim()) issues.push({ field: "provider", code: "PROVIDER_NOT_CONFIGURED", message: "Chưa nhập địa chỉ muse2api (vd http://127.0.0.1:18610)." });
    return issues;
  }

  /** ImageRequest của app.py. Body phải GIỐNG HỆT khi gửi lại cùng Idempotency-Key (không timestamp/ngẫu nhiên). */
  buildImageBody(input: ImageGenerationInput, config: ResolvedProviderConfig): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: IMAGE_MODEL_ID,
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio,
      size: input.aspectRatio,
    };
    const t = Number(config.options?.imageTimeoutSec);
    body.timeout = Math.round(Number.isFinite(t) && t > 0 ? Math.max(1, Math.min(600, t)) : 300);
    const ref = input.referenceImages[0];
    if (ref) body.reference_image = `data:${ref.mime};base64,${fs.readFileSync(ref.path).toString("base64")}`;
    const extra = config.options?.extraImagePrompt;
    if (typeof extra === "string" && extra.trim()) body.extra = extra.trim();
    return body;
  }

  async submitImage(input: ImageGenerationInput, ctx: ProviderCallContext): Promise<{ remoteJobId: string }> {
    const res = await this.call<MuseTask>(ctx, "POST", "/v1/images/tasks", this.buildImageBody(input, ctx.config), 60_000, { "Idempotency-Key": ctx.idempotencyKey.slice(0, 256) });
    const id = res?.id ?? res?.task_id;
    if (!id) throw new ProviderError("INVALID_RESULT", "muse2api không trả task id cho ảnh.");
    ctx.log(`[muse2api] đã tạo task ảnh ${id}`);
    return { remoteJobId: String(id) };
  }

  async getImageStatus(remoteJobId: string, ctx: ProviderCallContext): Promise<RemoteJobStatus> {
    const t = await this.call<MuseTask>(ctx, "GET", `/v1/images/tasks/${encodeURIComponent(remoteJobId)}`);
    return mapMuseTask(t, "ảnh");
  }

  async retrieveImage(remoteJobId: string, ctx: ProviderCallContext): Promise<RetrievedResult> {
    const t = await this.call<MuseTask>(ctx, "GET", `/v1/images/tasks/${encodeURIComponent(remoteJobId)}`);
    const raw = t.url ?? t.result?.url ?? "";
    if (mapMuseTask(t, "ảnh").status !== "completed" || !raw) throw new ProviderError("INVALID_RESULT", `Task ${remoteJobId} chưa có link ảnh (status=${t.status ?? "?"}).`);
    const url = this.absoluteUrl(ctx.config, raw);
    const ext = (/\.(png|jpe?g|webp)(?:\?|$)/i.exec(url)?.[1] ?? "webp").toLowerCase();
    return { url, mime: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg", expiresAt: null };
  }

  /** Kiểm cấu hình: /v1/models xác thực key, /readyz cho biết pool có tài khoản chưa. KHÔNG tạo video. */
  async testConnection(ctx: ProviderCallContext): Promise<{ ok: boolean; message: string }> {
    try {
      await this.call<{ data?: unknown[] }>(ctx, "GET", "/v1/models", undefined, 15_000);
    } catch (e) {
      const pe = e as ProviderError;
      return { ok: false, message: redact(`${pe.category ?? "UNKNOWN"}: ${pe.message}`, [ctx.config.apiKey]) };
    }
    try {
      const r = await this.call<{ status?: string; accounts?: number; browser_running?: boolean }>(ctx, "GET", "/readyz", undefined, 15_000);
      if (r?.status !== "ready")
        return { ok: false, message: `Kết nối được muse2api và key hợp lệ, nhưng pool CHƯA có tài khoản Muse nào (readyz=${r?.status ?? "?"}). Thêm tài khoản ở trang quản trị muse2api trước khi tạo video.` };
      return { ok: true, message: `Kết nối muse2api được: ${r.accounts ?? 0} tài khoản trong pool, trình duyệt ${r.browser_running ? "đang chạy" : "chưa chạy (sẽ tự mở khi có việc)"}.` };
    } catch (e) {
      const pe = e as ProviderError;
      return { ok: true, message: redact(`Key hợp lệ, nhưng không đọc được /readyz (${pe.message}). Kiểm tra pool tài khoản ở trang quản trị muse2api.`, [ctx.config.apiKey]) };
    }
  }
}

/** Chuẩn hoá task muse2api → trạng thái BVS. app.py đã map succeeded/success/done → completed. */
export function mapMuseTask(t: MuseTask, what: "video" | "ảnh" = "video"): RemoteJobStatus {
  const status = String(t.status ?? "").toLowerCase();
  // t.progress === null/undefined phải giữ null (Number(null) = 0 sẽ làm thanh tiến độ tụt về 0)
  const progress = t.progress === null || t.progress === undefined || !Number.isFinite(Number(t.progress)) ? null : Math.max(0, Math.min(100, Number(t.progress)));
  if (status === "completed" || status === "succeeded" || status === "success" || status === "done") return { status: "completed", progress: 100 };
  if (status === "queued" || status === "pending") return { status: "queued", progress };
  if (status === "processing" || status === "running") return { status: "processing", progress };
  if (status === "cancelled" || status === "canceled" || status === "stopped") return { status: "cancelled", progress };
  if (status === "failed" || status === "error") {
    const msg = t.error ?? `muse2api tạo ${what} thất bại.`;
    let category: ErrorCategory = "GENERATION_FAILED";
    let transient = false;
    if (AUTH_MSG.test(msg)) category = "AUTH";
    else if (QUOTA_MSG.test(msg)) category = "QUOTA";
    else if (POLICY_MSG.test(msg)) category = "CONTENT_POLICY";
    else if (TRANSIENT_MSG.test(msg)) {
      category = "TIMEOUT";
      transient = true;
    }
    return { status: "failed", progress, error: { category, message: msg, providerCode: null, transient } };
  }
  // Trạng thái lạ: coi là đang chạy để scheduler poll tiếp, không tự kết luận hỏng
  return { status: "processing", progress };
}
