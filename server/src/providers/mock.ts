import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.ts";
import type { MediaTools } from "../media.ts";
import { renderMockVideo } from "../media.ts";
import { newId, nowMs } from "../util.ts";
import {
  ProviderError,
  validateAgainstModel,
  type CostEstimate,
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
 * MOCK PROVIDER - CHỈ ĐỂ KIỂM THỬ. Không gọi mạng, không tốn tiền, không tạo
 * video AI: kết quả là video testsrc2 + chữ "MOCK" do ffmpeg dựng, để kiểm thử
 * luồng hàng đợi / xem / tải / phiên bản end-to-end.
 *
 * "Phía provider" giả lưu trong bảng mock_remote_tasks → sống qua restart, nên
 * kiểm được khôi phục hàng đợi. Hành vi điều khiển bằng option của cấu hình và
 * bằng dấu trong prompt:
 *   [mock:fail]            tạo video thất bại vĩnh viễn (CONTENT_POLICY)
 *   [mock:transient-submit] lần gửi đầu bị từ chối 503 (chứng minh chưa nhận) → được thử lại
 *   [mock:transient-gen]    lần tạo đầu thất bại tạm thời → được tạo lại
 *   [mock:submit-timeout]   lần gửi đầu: provider ĐÃ nhận nhưng mất phản hồi → gửi lại cùng idempotency key phải ra đúng job cũ
 *   [mock:slow]             chạy lâu gấp 3
 */
const MODELS: ModelCapabilities[] = [
  {
    modelId: "mock-standard",
    label: "Mock Standard (4-30s)",
    verified: true,
    modes: ["text-to-video", "image-to-video", "reference-to-video"],
    durations: { min: 4, max: 30, auto: true },
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    audio: true,
    negativePrompt: true,
    maxPromptChars: 2000,
    maxReferenceImages: 4,
    qualityModes: ["fast", "quality"],
    seed: true,
    notes: ["Model giả lập để kiểm thử - không tạo video AI, không tính phí."],
  },
  {
    modelId: "mock-short",
    label: "Mock Short (4-15s)",
    verified: true,
    modes: ["text-to-video"],
    durations: { min: 4, max: 15, auto: false },
    aspectRatios: ["16:9", "9:16", "1:1"],
    resolutions: ["480p", "720p"],
    defaultResolution: "720p",
    audio: false,
    negativePrompt: false,
    maxPromptChars: 500,
    maxReferenceImages: 0,
    qualityModes: [],
    seed: false,
    notes: ["Model giả lập giới hạn hẹp - dùng kiểm chặn thời lượng/âm thanh không hỗ trợ."],
  },
];

interface MockTaskRow {
  id: string;
  idempotency_key: string | null;
  provider_config_id: string;
  input_json: string;
  status: string;
  created_ms: number;
  started_ms: number | null;
  finish_ms: number;
  outcome: string;
  result_path: string | null;
  cancelled: number;
}

function opt(config: ResolvedProviderConfig, key: string, fallback: number): number {
  const v = Number(config.options?.[key]);
  return Number.isFinite(v) ? v : fallback;
}

export class MockProvider implements VideoProvider {
  readonly type = "mock";
  private db: Db;
  private media: MediaTools;

  constructor(db: Db, media: MediaTools) {
    this.db = db;
    this.media = media;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      providerType: "mock",
      label: "Mock (kiểm thử, không tính phí)",
      models: MODELS,
      cancel: "queued_only",
      idempotency: true,
      progress: true,
      webhook: false,
      concurrencyHint: null,
      pricing: "free-mock",
      docsUrl: null,
    };
  }

  validateInput(input: GenerationInput, config: ResolvedProviderConfig): ValidationIssue[] {
    const caps = this.getCapabilities();
    caps.models = caps.models.filter((m) => config.modelIds.length === 0 || config.modelIds.includes(m.modelId));
    return validateAgainstModel(input, caps);
  }

  estimateCost(): CostEstimate {
    return { amount: 0, currency: "USD", basis: "Mock provider - không tính phí", kind: "free-mock" };
  }

  /** Số lần gửi trước đó cho cùng một job (theo tiền tố idempotency key) */
  private priorSubmits(ctx: ProviderCallContext): number {
    const base = ctx.idempotencyKey.replace(/#\d+$/, "");
    const r = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mock_remote_tasks WHERE provider_config_id = ? AND idempotency_key LIKE ?", ctx.config.id, `${base}%`);
    return Number(r?.n ?? 0);
  }

  async submitGeneration(input: GenerationInput, ctx: ProviderCallContext): Promise<{ remoteJobId: string }> {
    const submitDelay = opt(ctx.config, "submitDelayMs", 0);
    if (submitDelay > 0) await new Promise((r) => setTimeout(r, submitDelay));

    // Idempotency: cùng key = cùng task, không tạo task thứ hai
    const existing = this.db.get<MockTaskRow>("SELECT * FROM mock_remote_tasks WHERE provider_config_id = ? AND idempotency_key = ?", ctx.config.id, ctx.idempotencyKey);
    if (existing) {
      ctx.log(`[mock] idempotency key đã có task ${existing.id} - trả lại task cũ`);
      return { remoteJobId: existing.id };
    }

    const p = input.prompt;
    const prior = this.priorSubmits(ctx);
    if (p.includes("[mock:transient-submit]") && prior === 0 && !this.flag(ctx, "transient-submit")) {
      this.setFlag(ctx, "transient-submit");
      throw new ProviderError("PROVIDER_UNAVAILABLE", "Mock: 503 Service Unavailable (lỗi tạm thời giả lập)", { httpStatus: 503, provenNotSubmitted: true, retryAfterSec: 1 });
    }

    const latency = opt(ctx.config, "latencyMs", 3000) * (p.includes("[mock:slow]") ? 3 : 1);
    const failRate = opt(ctx.config, "failRate", 0);
    let outcome = "success";
    if (p.includes("[mock:fail]")) outcome = "fail";
    else if (p.includes("[mock:transient-gen]") && prior === 0) outcome = "fail-transient";
    else if (failRate > 0 && Math.random() < failRate) outcome = "fail-transient";

    const id = newId("mocktask");
    const now = nowMs();
    this.db.run(
      `INSERT INTO mock_remote_tasks (id, idempotency_key, provider_config_id, input_json, status, created_ms, started_ms, finish_ms, outcome)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      id,
      ctx.idempotencyKey,
      ctx.config.id,
      JSON.stringify(input),
      now,
      now,
      now + Math.max(50, latency),
      outcome,
    );
    ctx.log(`[mock] tạo task ${id} (outcome=${outcome}, ~${latency}ms)`);

    if (p.includes("[mock:submit-timeout]") && !this.flag(ctx, "submit-timeout")) {
      this.setFlag(ctx, "submit-timeout");
      // Task ĐÃ được tạo nhưng client mất phản hồi
      throw new ProviderError("TIMEOUT", "Mock: mất kết nối sau khi gửi (giả lập)", { provenNotSubmitted: false });
    }
    return { remoteJobId: id };
  }

  private flagKey(ctx: ProviderCallContext, name: string): string {
    return `${ctx.idempotencyKey.replace(/#\d+$/, "")}:${name}`;
  }
  private flag(ctx: ProviderCallContext, name: string): boolean {
    return Boolean(this.db.get("SELECT 1 AS x FROM mock_remote_tasks WHERE id = ?", `flag:${this.flagKey(ctx, name)}`));
  }
  private setFlag(ctx: ProviderCallContext, name: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO mock_remote_tasks (id, idempotency_key, provider_config_id, input_json, status, created_ms, finish_ms, outcome)
       VALUES (?, NULL, ?, '{}', 'flag', 0, 0, 'flag')`,
      `flag:${this.flagKey(ctx, name)}`,
      ctx.config.id,
    );
  }

  private row(remoteJobId: string): MockTaskRow {
    const r = this.db.get<MockTaskRow>("SELECT * FROM mock_remote_tasks WHERE id = ?", remoteJobId);
    if (!r) throw new ProviderError("INVALID_INPUT", `Mock: không có task ${remoteJobId}`, { httpStatus: 404 });
    return r;
  }

  async getGenerationStatus(remoteJobId: string): Promise<RemoteJobStatus> {
    const r = this.row(remoteJobId);
    if (r.cancelled) return { status: "cancelled", progress: null };
    const now = nowMs();
    if (now < r.finish_ms) {
      const span = Math.max(1, r.finish_ms - r.created_ms);
      return { status: "processing", progress: Math.min(99, Math.round(((now - r.created_ms) / span) * 100)) };
    }
    if (r.outcome === "fail") return { status: "failed", progress: null, error: { category: "CONTENT_POLICY", message: "Mock: nội dung bị từ chối (giả lập)", providerCode: "MockContentPolicy", transient: false } };
    if (r.outcome === "fail-transient")
      return { status: "failed", progress: null, error: { category: "GENERATION_FAILED", message: "Mock: lỗi nội bộ tạm thời (giả lập)", providerCode: "MockInternalError", transient: true } };
    const input = JSON.parse(r.input_json) as GenerationInput;
    return { status: "completed", progress: 100, usage: { tokens: null, durationSec: input.durationSec === -1 ? 8 : input.durationSec } };
  }

  async cancelGeneration(remoteJobId: string): Promise<void> {
    const r = this.row(remoteJobId);
    // Mô phỏng provider chỉ hủy được khi còn xếp hàng: mock coi 300ms đầu là "xếp hàng"
    if (nowMs() - r.created_ms > 300) throw new ProviderError("INVALID_INPUT", "Mock: task đã chạy, không hủy được (chỉ hủy được khi còn xếp hàng).");
    this.db.run("UPDATE mock_remote_tasks SET cancelled = 1, status = 'cancelled' WHERE id = ?", remoteJobId);
  }

  async retrieveResult(remoteJobId: string, ctx: ProviderCallContext): Promise<RetrievedResult> {
    const r = this.row(remoteJobId);
    if (r.result_path && fs.existsSync(r.result_path)) return { filePath: r.result_path, mime: "video/mp4" };
    const input = JSON.parse(r.input_json) as GenerationInput;
    const out = path.join(ctx.workDir, `${remoteJobId}.mp4`);
    await renderMockVideo(this.media, out, {
      durationSec: Math.min(30, input.durationSec === -1 ? 8 : input.durationSec),
      aspect: input.aspectRatio,
      label: `${input.modelId} | ${input.prompt}`,
      withAudio: input.audio,
    });
    this.db.run("UPDATE mock_remote_tasks SET result_path = ?, status = 'succeeded' WHERE id = ?", out, remoteJobId);
    return { filePath: out, mime: "video/mp4" };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "Mock provider luôn sẵn sàng (không gọi mạng)." };
  }

  actualCost(): number | null {
    return 0;
  }
}
