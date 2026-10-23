import { getProEdit, startProEdit } from "./proedit.ts";
import { renderEdit } from "./autoedit.ts";
import { mergeVideos } from "./merge.ts";
import fs from "node:fs";
import path from "node:path";
import { z, type ZodTypeAny } from "zod";
import type { AppContext } from "./context.ts";
import { BatchService, defaultBatchConfig, type Actor, type BatchConfig, type BatchPromptInput } from "./batches.ts";
import { IMAGE_ASPECT_RATIOS, IMAGE_CONCURRENCY, IMAGE_MAX_VARIANTS, IMAGE_MODEL_ID, isImageCapable } from "./providers/types.ts";
import { listPages } from "./fbreels/config.ts";
import { DeployService } from "./deploy.ts";
import { audit } from "./events.ts";
import { ExportService } from "./exporter.ts";
import { PromptService } from "./promptgen.ts";
import { detectFormat, parsePrompts } from "./prompts.ts";
import { AppError } from "./util.ts";

/**
 * MỘT bộ tool dùng chung cho: Chat AI trong ứng dụng (OpenAI function calling),
 * MCP server (Hermes Agent / Claude Code...), CLI và REST /api/tools/:name.
 *
 * Luật chi phí (cưỡng chế ở đây + ở BatchService):
 *  - video_create_batch CHỈ tạo batch "chờ duyệt", không bao giờ chạy.
 *  - Kênh "chat" KHÔNG được duyệt/chạy việc tốn phí: trả về yêu cầu người dùng bấm
 *    Duyệt trên giao diện. Riêng provider Mock (miễn phí) thì chat được duyệt.
 *  - Kênh mcp/cli/api được duyệt khi gửi confirm=true + approvedMaxCost ≥ ước tính
 *    (agent phải hỏi người dùng trước - ghi trong mô tả tool).
 */
export type ToolChannel = "chat" | "mcp" | "cli" | "api";

export interface ToolCallCtx {
  workspaceId: string;
  userId: string;
  channel: ToolChannel;
  sessionId?: string | null;
}

export interface ToolDef<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  /** Tên theo đặc tả */
  alias: string;
  description: string;
  schema: S;
  handler(ctx: AppContext, call: ToolCallCtx, args: z.infer<S>): Promise<unknown>;
}

function def<S extends ZodTypeAny>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

const actorOf = (c: ToolCallCtx): Actor => ({ userId: c.userId, kind: c.channel === "chat" ? "chat" : c.channel === "mcp" ? "mcp" : "api-token" });

const batchConfigSchema = z.object({
  mode: z.enum(["text-to-video", "image-to-video", "reference-to-video"]).optional().describe("Chế độ tạo; mặc định text-to-video"),
  durationSec: z.number().int().optional().describe("Thời lượng mỗi video (giây); -1 = model tự chọn nếu hỗ trợ"),
  aspectRatio: z.string().optional().describe("Tỷ lệ khung, vd 9:16"),
  resolution: z.string().optional().describe("Độ phân giải, vd 720p"),
  audio: z.boolean().optional().describe("Tạo âm thanh (nếu model hỗ trợ)"),
  quality: z.string().nullable().optional().describe("fast | quality - chỉ khi model khai có"),
  variantsPerPrompt: z.number().int().min(1).max(10).optional().describe("Số lần tạo cho mỗi prompt"),
  referenceAssetIds: z.array(z.string()).optional().describe("Ảnh sản phẩm/nhân vật tham chiếu dùng chung"),
});

const promptSourceSchema = {
  promptSetId: z.string().optional().describe("Lấy prompt từ bộ prompt này (chỉ prompt đã duyệt nếu có, không thì mọi prompt chưa bị loại)"),
  prompts: z.array(z.string()).optional().describe("Hoặc danh sách prompt trực tiếp"),
};

function pickProvider(ctx: AppContext, workspaceId: string, providerConfigId?: string, modelId?: string): { providerConfigId: string; modelId: string } {
  const list = ctx.providers.list(workspaceId).filter((p) => p.enabled);
  const p = providerConfigId ? list.find((x) => x.id === providerConfigId) : list.find((x) => x.status === "active" && x.providerType !== "mock") ?? list.find((x) => x.status === "active");
  if (!p) throw new AppError("NO_PROVIDER", "Chưa có provider video nào đang bật (trang Provider).", 409);
  const m = modelId ?? p.defaultModelId ?? p.capabilities.models[0]?.modelId;
  if (!m) throw new AppError("NO_MODEL", "Provider chưa có model.", 409);
  return { providerConfigId: p.id, modelId: m };
}

function resolvePrompts(ctx: AppContext, workspaceId: string, args: { promptSetId?: string; prompts?: string[] }): { prompts: BatchPromptInput[]; promptSetId: string | null } {
  if (args.promptSetId) {
    const set = new PromptService(ctx).getSet(workspaceId, args.promptSetId);
    const approved = set.items.filter((i) => i.approval === "approved");
    const items = approved.length ? approved : set.items.filter((i) => i.approval !== "rejected");
    return {
      promptSetId: set.id,
      prompts: items.map((i) => ({ promptItemId: i.id, title: i.title, prompt: i.prompt, negative: i.negative, durationSec: i.durationSec, aspectRatio: i.aspectRatio, referenceAssetIds: i.referenceAssetIds })),
    };
  }
  if (args.prompts?.length) return { promptSetId: null, prompts: args.prompts.map((p) => ({ prompt: p })) };
  throw new AppError("NO_PROMPTS", "Cần promptSetId hoặc prompts.", 400);
}

function isFreeProvider(ctx: AppContext, workspaceId: string, providerConfigId: string): boolean {
  return ctx.providers.get(workspaceId, providerConfigId).capabilities.pricing === "free-mock";
}

export const TOOLS: ToolDef[] = [
  def({
    name: "video_list_assets",
    alias: "video.list_assets",
    description: "Liệt kê video/ảnh tham chiếu đã tải lên (của phiên hiện tại nếu có) để lấy assetId.",
    schema: z.object({ kind: z.enum(["reference", "image", "generated"]).optional(), sessionOnly: z.boolean().optional() }),
    async handler(ctx, c, a) {
      const where = ["workspace_id = ?"];
      const p: string[] = [c.workspaceId];
      if (a.kind) {
        where.push("kind = ?");
        p.push(a.kind);
      }
      if (a.sessionOnly && c.sessionId) {
        where.push("session_id = ?");
        p.push(c.sessionId);
      }
      const rows = ctx.db.all<{ id: string; kind: string; file_name: string; duration_sec: number | null; created_at: string }>(
        `SELECT id, kind, file_name, duration_sec, created_at FROM video_assets WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 100`,
        ...p,
      );
      return { assets: rows };
    },
  }),
  def({
    name: "video_get_provider_capabilities",
    alias: "video.get_provider_capabilities",
    description: "Danh sách provider video đang cấu hình + model, thời lượng, tỷ lệ, độ phân giải, âm thanh, khả năng hủy, chính sách giá. Gọi trước khi chọn thông số.",
    schema: z.object({ providerConfigId: z.string().optional() }),
    async handler(ctx, c, a) {
      const list = ctx.providers.list(c.workspaceId).filter((p) => !a.providerConfigId || p.id === a.providerConfigId);
      return {
        providers: list.map((p) => ({ id: p.id, name: p.name, type: p.providerType, status: p.status, maxConcurrency: p.maxConcurrency, requestsPerMinute: p.requestsPerMinute, defaultModelId: p.defaultModelId, capabilities: p.capabilities })),
      };
    },
  }),
  def({
    name: "video_generate_prompts",
    alias: "video.generate_prompts",
    description: "AI sinh hàng loạt prompt video KHÁC NHAU từ mô tả/brief của người dùng (đúng số lượng, tối ưu theo model). Tạo bộ prompt CHỜ DUYỆT - không tạo video, không tốn phí video.",
    schema: z.object({
      count: z.number().int().min(1).max(10),
      durationSec: z.number().int(),
      aspectRatio: z.string(),
      providerConfigId: z.string().optional(),
      modelId: z.string().optional(),
      genres: z.array(z.string()).optional().describe("product | talking-head | cinematic | motion-graphics | lifestyle | ugc-review | tutorial | unboxing"),
      brief: z.string().optional().describe("Yêu cầu/brief của người dùng"),
      consistency: z.object({ product: z.string().optional(), brand: z.string().optional(), character: z.string().optional() }).optional(),
      referenceAssetIds: z.array(z.string()).optional(),
      language: z.enum(["vi", "en"]).optional(),
      name: z.string().optional(),
    }),
    async handler(ctx, c, a) {
      const pick = pickProvider(ctx, c.workspaceId, a.providerConfigId, a.modelId);
      const r = await new PromptService(ctx).generate(c.workspaceId, actorOf(c), { ...a, ...pick, sessionId: c.sessionId ?? null });
      return { promptSetId: r.set.id, name: r.set.name, requested: r.requested, generated: r.generated, shortfall: r.shortfall, message: r.message, preview: r.set.items.slice(0, 5).map((i) => ({ index: i.index, title: i.title, prompt: i.prompt.slice(0, 200) })) };
    },
  }),
  def({
    name: "video_import_prompts",
    alias: "video.import_prompts",
    description: "Tạo bộ prompt từ nội dung file TXT (mỗi dòng một prompt) / CSV / JSON hoặc văn bản dán. Báo dòng trống, trùng.",
    schema: z.object({ text: z.string().min(1), fileName: z.string().optional(), name: z.string().optional() }),
    async handler(ctx, c, a) {
      const fmt = detectFormat(a.fileName, a.text);
      const parsed = parsePrompts(a.text, fmt);
      if (!parsed.items.length) throw new AppError("NO_PROMPTS", "Không đọc được prompt nào.", 400, parsed.errors);
      const set = new PromptService(ctx).createSet(c.workspaceId, actorOf(c), { sessionId: c.sessionId ?? null, name: a.name ?? a.fileName ?? "Prompt nhập", source: "import", items: parsed.items.map((i) => i.draft) });
      return { promptSetId: set.id, count: set.items.length, blankLines: parsed.blankLines, errors: parsed.errors, summary: `${parsed.items.length} dòng có nội dung (bỏ ${parsed.blankLines.length} dòng trống)` };
    },
  }),
  def({
    name: "video_clear_negatives",
    alias: "video.clear_negatives",
    description: "Xóa negative prompt của cả bộ prompt. Dùng khi model đích KHÔNG nhận negative (vd Muse qua muse2api) - prompt chính giữ nguyên, chỉ bỏ trống negative.",
    schema: z.object({ promptSetId: z.string() }),
    async handler(ctx, c, a) {
      const cleared = new PromptService(ctx).clearNegatives(c.workspaceId, a.promptSetId);
      return { promptSetId: a.promptSetId, cleared, summary: cleared ? `Đã dọn negative ${cleared} prompt` : "Bộ này không có negative nào cần dọn" };
    },
  }),
  def({
    name: "video_estimate_batch",
    alias: "video.estimate_batch",
    description: "Kiểm prompt + ước tính chi phí/số video của một batch TRƯỚC khi tạo (không gọi provider).",
    schema: z.object({ ...promptSourceSchema, providerConfigId: z.string().optional(), modelId: z.string().optional(), config: batchConfigSchema.optional(), maxConcurrency: z.number().int().min(1).max(64).optional(), budgetLimit: z.number().nullable().optional() }),
    async handler(ctx, c, a) {
      const pick = pickProvider(ctx, c.workspaceId, a.providerConfigId, a.modelId);
      const { prompts } = resolvePrompts(ctx, c.workspaceId, a);
      const config = defaultBatchConfig(a.config as Partial<BatchConfig>);
      const svc = new BatchService(ctx);
      const check = svc.check(c.workspaceId, { ...pick, config, prompts });
      const estimate = svc.estimate(c.workspaceId, { ...pick, config, prompts, maxConcurrency: a.maxConcurrency ?? 2, budgetLimit: a.budgetLimit ?? null });
      return { ...pick, check: { ok: check.ok, summary: check.summary, jobCount: check.jobCount, batchIssues: check.batchIssues, invalid: check.items.filter((i) => !i.valid).slice(0, 20) }, estimate: { ...estimate, perJob: undefined } };
    },
  }),
  def({
    name: "video_list_fb_pages",
    alias: "video.list_fb_pages",
    description: "Liệt kê các Page Facebook đã cấu hình (chỉ đọc, không có token). Khi có Page, video_create_batch / video_deploy_prompt_set BẮT BUỘC có fbPage (id Page hoặc 'none') - hỏi người dùng muốn đăng lên Page nào hoặc không đăng.",
    schema: z.object({}),
    async handler(ctx, c) {
      const pages = listPages(ctx, c.workspaceId);
      return {
        required: pages.length > 0,
        pages: pages.map((p) => ({ id: p.id, name: p.name, pageId: p.pageId, tokenLast4: p.tokenLast4, autoEnabled: p.autoEnabled, paused: Boolean(p.pause) })),
        note: pages.length ? "Hỏi người dùng đăng lên Page nào (hoặc không đăng), rồi truyền id vào fbPage ('none' = không đăng)." : "Chưa cấu hình Page nào: không cần fbPage.",
      };
    },
  }),
  def({
    name: "video_create_batch",
    alias: "video.create_batch",
    description:
      "Tạo batch video ở trạng thái CHỜ DUYỆT (không chạy, không tốn phí) kèm ước tính chi phí. Sau đó người dùng phải duyệt: trong ứng dụng bấm 'Duyệt & chạy'; agent ngoài chỉ gọi video_approve_batch SAU KHI người dùng đồng ý rõ ràng với con số chi phí.",
    schema: z.object({ ...promptSourceSchema, name: z.string().optional(), providerConfigId: z.string().optional(), modelId: z.string().optional(), config: batchConfigSchema.optional(), maxConcurrency: z.number().int().min(1).max(64).optional(), budgetLimit: z.number().nullable().optional(), fbPage: z.string().optional().describe("Đăng lên Page Facebook: id Page (lấy từ video_list_fb_pages) hoặc 'none' = không đăng lên Facebook. BẮT BUỘC khi đã có Page - hãy HỎI người dùng, không tự chọn") }),
    async handler(ctx, c, a) {
      const pick = pickProvider(ctx, c.workspaceId, a.providerConfigId, a.modelId);
      const { prompts, promptSetId } = resolvePrompts(ctx, c.workspaceId, a);
      const r = new BatchService(ctx).createBatch(c.workspaceId, actorOf(c), {
        sessionId: c.sessionId ?? null,
        name: a.name,
        mode: promptSetId ? "ai" : "list",
        promptSetId,
        ...pick,
        config: a.config as Partial<BatchConfig>,
        prompts,
        maxConcurrency: a.maxConcurrency,
        budgetLimit: a.budgetLimit ?? null,
        fbPage: a.fbPage ?? null,
      });
      return {
        batchId: r.batch.id,
        status: r.batch.status,
        summary: r.check.summary,
        estimate: { total: r.estimate.total, currency: r.estimate.currency, kind: r.estimate.kind, basis: r.estimate.basis, effectiveConcurrency: r.estimate.effectiveConcurrency, notes: r.estimate.notes },
        approval: "Batch đang CHỜ DUYỆT. Hiển thị ước tính cho người dùng và chờ họ xác nhận.",
      };
    },
  }),
  def({
    name: "video_create_image_batch",
    alias: "video.create_image_batch",
    description:
      "Tạo batch ẢNH (Muse Image qua muse2api) ở trạng thái CHỜ DUYỆT - KHÔNG chạy. Mỗi prompt × variantsPerPrompt = số ảnh (~40 giây/ảnh, tiêu hạn mức nick Muse). Sau đó HỎI người dùng; chỉ gọi video_approve_batch khi họ đồng ý (acknowledgeUnknownCost=true; từ 30 ảnh trở lên thêm confirmLarge=true). Không có ảnh tham chiếu thì bỏ referenceAssetId.",
    schema: z.object({
      ...promptSourceSchema,
      name: z.string().optional(),
      aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional().describe("Tỉ lệ khung hình; mặc định 1:1"),
      variantsPerPrompt: z.number().int().min(1).max(IMAGE_MAX_VARIANTS).optional().describe("Số ảnh cho mỗi prompt (1-4)"),
      referenceAssetId: z.string().optional().describe("1 ảnh tham chiếu sản phẩm (assetId kind=image)"),
      maxConcurrency: z.number().int().min(IMAGE_CONCURRENCY.min).max(IMAGE_CONCURRENCY.max).optional().describe("Số ảnh chạy song song (1-6, mặc định 3)"),
      providerConfigId: z.string().optional(),
    }),
    async handler(ctx, c, a) {
      const list = ctx.providers.list(c.workspaceId).filter((p) => p.enabled && isImageCapable(ctx.providers.adapter(p.providerType)));
      const p = a.providerConfigId ? list.find((x) => x.id === a.providerConfigId) : list.find((x) => x.status === "active") ?? list[0];
      if (!p) throw new AppError("NO_IMAGE_PROVIDER", "Chưa có provider Muse (muse2api) nào đang bật để tạo ảnh.", 409);
      const { prompts, promptSetId } = resolvePrompts(ctx, c.workspaceId, a);
      const r = new BatchService(ctx).createBatch(c.workspaceId, actorOf(c), {
        kind: "image",
        sessionId: c.sessionId ?? null,
        name: a.name,
        mode: promptSetId ? "ai" : "list",
        promptSetId,
        providerConfigId: p.id,
        modelId: IMAGE_MODEL_ID,
        config: { aspectRatio: a.aspectRatio ?? "1:1", variantsPerPrompt: a.variantsPerPrompt ?? 1, referenceAssetIds: a.referenceAssetId ? [a.referenceAssetId] : [] } as unknown as Partial<BatchConfig>,
        prompts: prompts.map((x) => ({ ...x, durationSec: null, negative: null })),
        maxConcurrency: a.maxConcurrency ?? IMAGE_CONCURRENCY.default,
      });
      return {
        batchId: r.batch.id,
        status: r.batch.status,
        summary: r.check.summary,
        estimate: { total: r.estimate.total, currency: r.estimate.currency, kind: r.estimate.kind, basis: r.estimate.basis, effectiveConcurrency: r.estimate.effectiveConcurrency, notes: r.estimate.notes },
        approval: "Batch ảnh đang CHỜ DUYỆT. Báo người dùng số ảnh + ước tính thời gian và chờ họ xác nhận.",
      };
    },
  }),
  def({
    name: "video_approve_batch",
    alias: "video.approve_batch",
    description:
      "Duyệt và CHẠY batch đang chờ duyệt (có thể TỐN PHÍ). CHỈ gọi khi người dùng đã đồng ý rõ ràng với chi phí ước tính. confirm=true; approvedMaxCost ≥ ước tính khi chi phí xác định; acknowledgeUnknownCost=true khi không ước tính được.",
    schema: z.object({ batchId: z.string(), confirm: z.boolean(), approvedMaxCost: z.number().nullable().optional(), acknowledgeUnknownCost: z.boolean().optional(), confirmLarge: z.boolean().optional().describe("Batch ảnh từ 30 ảnh trở lên: phải true sau khi người dùng đồng ý số lượng") }),
    async handler(ctx, c, a) {
      const svc = new BatchService(ctx);
      const b = svc.getBatchRow(c.workspaceId, a.batchId);
      if (c.channel === "chat" && !isFreeProvider(ctx, c.workspaceId, b.provider_config_id))
        return { needsUserApproval: true, batchId: b.id, estimate: b.estimated_cost, currency: b.currency, message: "Batch có thể tính phí: người dùng phải tự bấm 'Duyệt & chạy' trên giao diện. Trợ lý không được tự duyệt." };
      const r = svc.approveBatch(c.workspaceId, actorOf(c), a.batchId, { confirm: a.confirm, approvedMaxCost: a.approvedMaxCost, acknowledgeUnknownCost: a.acknowledgeUnknownCost, confirmLarge: a.confirmLarge });
      return { batchId: r.id, status: r.status };
    },
  }),
  def({
    name: "video_deploy_prompt_set",
    alias: "video.deploy_prompt_set",
    description:
      "TRIỂN KHAI bộ prompt thành video khi người dùng nói 'triển khai' / 'làm video từ các prompt này': MỖI PROMPT = ĐÚNG 1 VIDEO (N prompt → N video, không nhân bản). Mặc định lấy prompt đã duyệt nếu có, không thì mọi prompt chưa bị loại (selection). Provider/model mặc định = cái đã dùng khi sinh bộ prompt. Provider MIỄN PHÍ (Mock) → chạy luôn. Provider TÍNH PHÍ → tạo batch CHỜ DUYỆT + trả ước tính; chỉ truyền confirm=true + approvedMaxCost (≥ ước tính) khi người dùng ĐÃ đồng ý rõ ràng con số chi phí. dryRun=true để xem trước số video + chi phí mà không tạo gì.",
    schema: z.object({
      promptSetId: z.string(),
      selection: z.enum(["auto", "approved", "all"]).optional().describe("auto (mặc định) | approved = chỉ prompt đã duyệt | all = mọi prompt chưa bị loại"),
      providerConfigId: z.string().optional(),
      modelId: z.string().optional(),
      config: batchConfigSchema.optional().describe("Thông số video; variantsPerPrompt luôn bị ép = 1"),
      name: z.string().optional(),
      maxConcurrency: z.number().int().min(1).max(64).optional(),
      budgetLimit: z.number().nullable().optional(),
      fbPage: z.string().optional().describe("Đăng lên Page Facebook: id Page (lấy từ video_list_fb_pages) hoặc 'none' = không đăng lên Facebook. BẮT BUỘC khi đã có Page - hãy HỎI người dùng, không tự chọn"),
      dryRun: z.boolean().optional(),
      confirm: z.boolean().optional(),
      approvedMaxCost: z.number().nullable().optional(),
      acknowledgeUnknownCost: z.boolean().optional(),
    }),
    async handler(ctx, c, a) {
      // Kênh chat trong app không được tự duyệt việc tính phí → chỉ tự chạy khi provider miễn phí
      const run = c.channel !== "chat" && a.confirm ? { confirm: true, approvedMaxCost: a.approvedMaxCost ?? null, acknowledgeUnknownCost: a.acknowledgeUnknownCost } : null;
      const r = new DeployService(ctx).deploy(c.workspaceId, actorOf(c), a.promptSetId, {
        sessionId: c.sessionId ?? undefined,
        providerConfigId: a.providerConfigId,
        modelId: a.modelId,
        config: (a.config ?? {}) as Partial<BatchConfig>,
        selection: a.selection,
        name: a.name,
        maxConcurrency: a.maxConcurrency,
        budgetLimit: a.budgetLimit ?? null,
        dryRun: a.dryRun,
        run,
        fbPage: a.fbPage ?? null,
        autoRunIfFree: true,
      });
      const est = { total: r.estimate.total, currency: r.estimate.currency, kind: r.estimate.kind, effectiveConcurrency: r.estimate.effectiveConcurrency, notes: r.estimate.notes };
      const head = { promptSetId: r.promptSetId, promptCount: r.promptCount, videoCount: r.videoCount, summary: `${r.promptCount} prompt → ${r.videoCount} video`, providerConfigId: r.providerConfigId, modelId: r.modelId, free: r.free, estimate: est };
      if (r.dryRun)
        return { ...head, dryRun: true, ok: r.check.ok, batchIssues: r.check.batchIssues, invalid: r.check.items.filter((i) => !i.valid).slice(0, 20).map((i) => ({ line: i.line, issues: i.issues.map((x) => x.message) })) };
      const batchId = r.batch!.id;
      if (r.approved) return { ...head, batchId, status: r.batch!.status === "awaiting_approval" ? "running" : r.batch!.status, approved: true, message: `Đã triển khai: ${r.videoCount} video đang chạy.` };
      return {
        ...head,
        batchId,
        status: "awaiting_approval",
        approved: false,
        approveError: r.approveError,
        needsUserApproval: c.channel === "chat" ? true : undefined,
        message: `Đã tạo batch CHỜ DUYỆT gồm ${r.videoCount} video (ước tính ${est.total ?? "không xác định"} ${est.currency}). Báo người dùng con số này; chỉ chạy khi họ đồng ý rõ ràng${c.channel === "chat" ? " - người dùng bấm 'Duyệt & chạy' trên giao diện" : " (gọi video_approve_batch với confirm=true + approvedMaxCost)"}.`,
      };
    },
  }),
  def({
    name: "video_get_batch_status",
    alias: "video.get_batch_status",
    description: "Trạng thái batch: số job theo trạng thái, tiến độ, chi phí ước tính/thực tế, job lỗi. Không truyền batchId = batch mới nhất.",
    schema: z.object({ batchId: z.string().optional(), includeJobs: z.boolean().optional() }),
    async handler(ctx, c, a) {
      const svc = new BatchService(ctx);
      const b = a.batchId ? svc.getBatchRow(c.workspaceId, a.batchId) : ctx.db.get<{ id: string }>("SELECT id FROM video_batches WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1", c.workspaceId);
      if (!b) return { batches: [], message: "Chưa có batch nào." };
      const pub = svc.batchToPublic(svc.getBatchRow(c.workspaceId, b.id));
      const failed = svc.listJobs(c.workspaceId, { batchId: b.id, statuses: ["failed"], limit: 50 }).jobs.map((j) => ({ id: j.id, seq: j.seq, error: j.error }));
      const jobs = a.includeJobs ? svc.listJobs(c.workspaceId, { batchId: b.id, limit: 200 }).jobs.map((j) => ({ id: j.id, seq: j.seq, status: j.status, progress: j.progress, version: j.version, assetId: j.outputAssetId })) : undefined;
      return { batch: { ...pub, estimate: undefined }, failed, jobs };
    },
  }),
  def({
    name: "video_pause_batch",
    alias: "video.pause_batch",
    description: "Tạm dừng batch: không gửi job mới (job đang chạy ở provider vẫn được theo dõi).",
    schema: z.object({ batchId: z.string() }),
    async handler(ctx, c, a) {
      const r = new BatchService(ctx).setBatchStatus(c.workspaceId, actorOf(c), a.batchId, "pause");
      return { batchId: r.id, status: r.status };
    },
  }),
  def({
    name: "video_resume_batch",
    alias: "video.resume_batch",
    description: "Tiếp tục batch đã tạm dừng.",
    schema: z.object({ batchId: z.string() }),
    async handler(ctx, c, a) {
      const r = new BatchService(ctx).setBatchStatus(c.workspaceId, actorOf(c), a.batchId, "resume");
      return { batchId: r.id, status: r.status };
    },
  }),
  def({
    name: "video_cancel_job",
    alias: "video.cancel_job",
    description: "Hủy MỘT job (jobId) - không ảnh hưởng job khác; hoặc hủy mọi job CHƯA chạy của batch (batchId + pendingOnly=true).",
    schema: z.object({ jobId: z.string().optional(), batchId: z.string().optional(), pendingOnly: z.boolean().optional() }),
    async handler(ctx, c, a) {
      const svc = new BatchService(ctx);
      if (a.jobId) {
        const r = await svc.cancelJob(c.workspaceId, actorOf(c), a.jobId);
        return { jobId: a.jobId, cancelled: r.cancelled, status: r.job.status, message: r.message };
      }
      if (a.batchId && a.pendingOnly) return { batchId: a.batchId, cancelled: svc.cancelPending(c.workspaceId, actorOf(c), a.batchId) };
      throw new AppError("NO_TARGET", "Cần jobId, hoặc batchId + pendingOnly=true.", 400);
    },
  }),
  def({
    name: "video_retry_job",
    alias: "video.retry_job",
    description: "Tạo lại job lỗi (jobIds, hoặc mọi job lỗi của batchId). Có thể tốn phí: kênh chat trả về yêu cầu người dùng xác nhận trên giao diện; agent ngoài cần confirm=true + approvedMaxCost sau khi người dùng đồng ý.",
    schema: z.object({ batchId: z.string().optional(), jobIds: z.array(z.string()).optional(), confirm: z.boolean().optional(), approvedMaxCost: z.number().nullable().optional(), acknowledgeUnknownCost: z.boolean().optional() }),
    async handler(ctx, c, a) {
      const svc = new BatchService(ctx);
      const providerId = a.jobIds?.length ? svc.getJobRow(c.workspaceId, a.jobIds[0]!).provider_config_id : a.batchId ? svc.getBatchRow(c.workspaceId, a.batchId).provider_config_id : null;
      const free = providerId ? isFreeProvider(ctx, c.workspaceId, providerId) : false;
      if (c.channel === "chat" && !free) {
        try {
          svc.retryJobs(c.workspaceId, actorOf(c), { batchId: a.batchId, jobIds: a.jobIds, confirm: false });
        } catch (e) {
          const err = e as AppError;
          if (err.code === "CONFIRMATION_REQUIRED") return { needsUserApproval: true, kind: "retry", batchId: a.batchId ?? null, jobIds: a.jobIds ?? null, details: err.details, message: `${err.message} Người dùng bấm "Tạo lại" trên giao diện để xác nhận.` };
          throw e;
        }
        return { retried: [], message: "Không có job lỗi nào để tạo lại." };
      }
      return svc.retryJobs(c.workspaceId, actorOf(c), { batchId: a.batchId, jobIds: a.jobIds, confirm: c.channel === "chat" ? true : Boolean(a.confirm), approvedMaxCost: a.approvedMaxCost, acknowledgeUnknownCost: c.channel === "chat" ? true : a.acknowledgeUnknownCost });
    },
  }),
  def({
    name: "video_get_result",
    alias: "video.get_result",
    description: "Kết quả một job: trạng thái, link xem/tải video, các phiên bản V1/V2...",
    schema: z.object({ jobId: z.string() }),
    async handler(ctx, c, a) {
      const svc = new BatchService(ctx);
      const j = svc.jobToPublic(svc.getJobRow(c.workspaceId, a.jobId));
      return { job: j, versions: svc.versions(c.workspaceId, a.jobId).map((v) => ({ id: v.id, version: v.version, status: v.status, output: v.output })) };
    },
  }),
  def({
    name: "video_regenerate",
    alias: "video.regenerate",
    description: "Tạo PHIÊN BẢN MỚI (V2, V3...) của một video, có thể sửa prompt. Bản cũ được giữ. Mặc định tạo ở trạng thái chờ duyệt; agent ngoài có thể confirm=true + approvedMaxCost sau khi người dùng đồng ý.",
    schema: z.object({ jobId: z.string(), prompt: z.string().optional(), negative: z.string().nullable().optional(), durationSec: z.number().int().optional(), aspectRatio: z.string().optional(), confirm: z.boolean().optional(), approvedMaxCost: z.number().nullable().optional(), acknowledgeUnknownCost: z.boolean().optional() }),
    async handler(ctx, c, a) {
      const svc = new BatchService(ctx);
      const src = svc.getJobRow(c.workspaceId, a.jobId);
      const free = isFreeProvider(ctx, c.workspaceId, src.provider_config_id);
      const confirm = c.channel === "chat" ? free : Boolean(a.confirm);
      const j = svc.regenerate(c.workspaceId, actorOf(c), a.jobId, { ...a, confirm, acknowledgeUnknownCost: c.channel === "chat" ? free : a.acknowledgeUnknownCost });
      return { jobId: j.id, version: j.version, status: j.status, message: j.status === "awaiting_approval" ? "Phiên bản mới đang CHỜ DUYỆT - người dùng bấm Duyệt để chạy." : "Phiên bản mới đã vào hàng đợi." };
    },
  }),
  def({
    name: "video_export_batch",
    alias: "video.export_batch",
    description: "Xuất batch: zip (mọi video đã xong + manifest + prompt), csv/json (metadata), txt (prompt mỗi dòng). Trả link tải (ứng dụng) hoặc đường dẫn file (CLI/MCP).",
    schema: z.object({ batchId: z.string(), format: z.enum(["zip", "csv", "json", "txt"]) }),
    async handler(ctx, c, a) {
      const exp = new ExportService(ctx);
      const url = `/api/batches/${a.batchId}/export?format=${a.format}`;
      if (c.channel === "chat" || c.channel === "api") {
        new BatchService(ctx).getBatchRow(c.workspaceId, a.batchId);
        return { downloadUrl: url };
      }
      const dir = path.join(ctx.cfg.dataDir, "exports");
      fs.mkdirSync(dir, { recursive: true });
      if (a.format === "zip") {
        const tmp = path.join(dir, `${a.batchId}-${Date.now()}.zip`);
        const out = fs.createWriteStream(tmp);
        const r = await exp.zipBatch(c.workspaceId, a.batchId, out, { userId: c.userId, kind: c.channel });
        return { file: tmp, videos: r.videos };
      }
      const t = exp.exportText(c.workspaceId, a.batchId, a.format);
      const f = path.join(dir, t.fileName);
      fs.writeFileSync(f, t.body);
      return { file: f };
    },
  }),
  def({
    name: "video_pro_edit",
    alias: "video.pro_edit",
    description: "Dựng NÂNG CAO bằng Claude Code CLI + skill HyperFrames (tiêu đề động, caption, chuyển cảnh...). Chạy nền 5-10 phút: trả jobId ngay, rồi gọi video_pro_edit_status tới khi done. Dùng quota Claude của máy (không phải vinh1). Muốn nhanh/đơn giản dùng video_auto_edit.",
    schema: z.object({ assetIds: z.array(z.string()).min(2), brief: z.string().optional(), name: z.string().optional() }),
    async handler(ctx, c, a) {
      const j = startProEdit(ctx, { workspaceId: c.workspaceId, userId: c.userId, actor: actorOf(c).kind, assetIds: a.assetIds, brief: a.brief, name: a.name, sessionId: c.sessionId ?? null });
      return { jobId: j.id, status: j.status, message: j.message };
    },
  }),
  def({
    name: "video_pro_edit_status",
    alias: "video.pro_edit_status",
    description: "Trạng thái lượt dựng nâng cao (running/done/failed); done thì có assetId của video trong Thư viện.",
    schema: z.object({ jobId: z.string() }),
    async handler(ctx, c, a) {
      return getProEdit(c.workspaceId, a.jobId);
    },
  }),
  def({
    name: "video_auto_edit",
    alias: "video.auto_edit",
    description: "AI tự dựng: model chữ (vinh1) xem mô tả các clip rồi lên kế hoạch - sắp thứ tự, cắt đầu/đuôi, chuyển cảnh, chèn caption - FFmpeg render thành 1 video hoàn chỉnh vào Thư viện. Không tốn quota provider. brief = yêu cầu về nhịp/nội dung/caption.",
    schema: z.object({ assetIds: z.array(z.string()).min(2), brief: z.string().optional(), name: z.string().optional() }),
    async handler(ctx, c, a) {
      const r = await renderEdit(ctx, { workspaceId: c.workspaceId, userId: c.userId, actor: actorOf(c).kind, assetIds: a.assetIds, brief: a.brief, name: a.name, sessionId: c.sessionId ?? null });
      return { assetId: r.asset.id, fileName: r.asset.file_name, durationSec: r.asset.duration_sec, plan: r.plan, message: `Đã dựng ${r.plan.clips.length} clip thành 1 video ${Math.round(r.asset.duration_sec ?? 0)}s.` };
    },
  }),
  def({
    name: "video_merge_videos",
    alias: "video.merge_videos",
    description: "Ghép nhiều video đã có (assetIds, theo đúng thứ tự) thành 1 video hoàn chỉnh bằng FFmpeg trên máy - không gọi provider, không tốn quota/tiền. Kết quả vào Thư viện. Khác khung hình thì tự co về khung của clip đầu.",
    schema: z.object({ assetIds: z.array(z.string()).min(2), name: z.string().optional().describe("Tên file kết quả (không cần .mp4)") }),
    async handler(ctx, c, a) {
      const r = await mergeVideos(ctx, { workspaceId: c.workspaceId, userId: c.userId, actor: actorOf(c).kind, sessionId: c.sessionId ?? null, assetIds: a.assetIds, name: a.name });
      return { assetId: r.id, fileName: r.file_name, durationSec: r.duration_sec, sizeMb: Math.round((r.size_bytes / 1048576) * 10) / 10, message: `Đã ghép ${a.assetIds.length} video thành 1 (${Math.round(r.duration_sec ?? 0)}s), đã thêm vào Thư viện.` };
    },
  }),
  def({
    name: "video_delete_videos",
    alias: "video.delete_videos",
    description:
      "XÓA HẲN video đã tạo (file trên đĩa + dữ liệu) để dọn rác. Không khôi phục được. assetIds lấy từ video_list_assets/video_get_result (outputAssetId), hoặc batchId = xóa mọi video của batch đó. Bỏ qua video đang được job chưa xong dùng làm tham chiếu. confirm=true bắt buộc (không tốn phí, nhưng mất dữ liệu).",
    schema: z.object({
      assetIds: z.array(z.string()).optional().describe("Danh sách assetId cần xóa"),
      batchId: z.string().optional().describe("Hoặc: xóa mọi video đã tạo của batch này (batch + job vẫn giữ)"),
      confirm: z.boolean().describe("Phải true - xác nhận xóa vĩnh viễn"),
    }),
    async handler(ctx, c, a) {
      if (!a.confirm) throw new AppError("CONFIRMATION_REQUIRED", "Xóa video là không thể hoàn tác - cần confirm=true sau khi người dùng đồng ý.", 409);
      let ids = a.assetIds ?? [];
      if (a.batchId) {
        new BatchService(ctx).getBatchRow(c.workspaceId, a.batchId);
        ids = [
          ...ids,
          ...ctx.db
            .all<{ id: string }>("SELECT a.id FROM video_assets a JOIN video_batch_jobs j ON j.id = a.source_job_id WHERE j.batch_id = ? AND a.workspace_id = ?", a.batchId, c.workspaceId)
            .map((r) => r.id),
        ];
      }
      if (!ids.length) throw new AppError("NO_ASSETS", "Cần assetIds hoặc batchId có video.", 400);
      const r = ctx.storage.deleteAssets(c.workspaceId, ids, { skipInUse: true });
      audit(ctx.db, { workspaceId: c.workspaceId, userId: c.userId, actor: actorOf(c).kind, action: "asset.delete", targetType: "assets", targetId: r.deleted.join(","), data: { deleted: r.deleted.length, skipped: r.skipped.length, freedBytes: r.freedBytes } });
      return { deleted: r.deleted.length, skipped: r.skipped, freedMb: Math.round((r.freedBytes / 1048576) * 10) / 10, message: `Đã xóa ${r.deleted.length} video${r.skipped.length ? `, bỏ qua ${r.skipped.length}` : ""}.` };
    },
  }),
  def({
    name: "video_delete_batch",
    alias: "video.delete_batch",
    description:
      "XÓA HẲN một batch: batch + mọi job + lịch sử sự kiện, và cả video đã tạo của batch (keepAssets=true để giữ video lại trong Thư viện). Không khôi phục được; batch còn job đang chạy ở provider phải hủy trước. confirm=true bắt buộc.",
    schema: z.object({ batchId: z.string(), keepAssets: z.boolean().optional(), confirm: z.boolean() }),
    async handler(ctx, c, a) {
      if (!a.confirm) throw new AppError("CONFIRMATION_REQUIRED", "Xóa batch là không thể hoàn tác - cần confirm=true sau khi người dùng đồng ý.", 409);
      const r = new BatchService(ctx).deleteBatch(c.workspaceId, actorOf(c), a.batchId, { keepAssets: a.keepAssets });
      return { ...r, freedMb: Math.round((r.freedBytes / 1048576) * 10) / 10, message: `Đã xóa batch: ${r.jobsDeleted} job, ${r.assetsDeleted} video.` };
    },
  }),
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name || t.alias === name);
}

export async function invokeTool(ctx: AppContext, call: ToolCallCtx, name: string, rawArgs: unknown): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new AppError("TOOL_NOT_FOUND", `Không có tool "${name}".`, 404);
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new AppError("TOOL_ARGS_INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);
  return tool.handler(ctx, call, parsed.data);
}

// ---------------------------------------------------------------- zod → JSON Schema (tập con dùng ở trên)

export function toJsonSchema(s: ZodTypeAny): Record<string, unknown> {
  const d = s._def as { typeName: string; description?: string; innerType?: ZodTypeAny; type?: ZodTypeAny; values?: string[]; shape?: () => Record<string, ZodTypeAny>; checks?: { kind: string; value?: number }[] };
  const withDesc = (o: Record<string, unknown>) => (s.description ? { ...o, description: s.description } : o);
  switch (d.typeName) {
    case "ZodObject": {
      const shape = (s as z.ZodObject<Record<string, ZodTypeAny>>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = toJsonSchema(v);
        if (!v.isOptional()) required.push(k);
      }
      return withDesc({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
    }
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber": {
      const isInt = d.checks?.some((c) => c.kind === "int");
      const o: Record<string, unknown> = { type: isInt ? "integer" : "number" };
      for (const c of d.checks ?? []) {
        if (c.kind === "min") o.minimum = c.value;
        if (c.kind === "max") o.maximum = c.value;
      }
      return withDesc(o);
    }
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodArray":
      return withDesc({ type: "array", items: toJsonSchema(d.type!) });
    case "ZodEnum":
      return withDesc({ type: "string", enum: d.values });
    case "ZodOptional":
    case "ZodDefault": {
      const inner = toJsonSchema(d.innerType!);
      return s.description ? { ...inner, description: s.description } : inner;
    }
    case "ZodNullable": {
      const inner = toJsonSchema(d.innerType!);
      return { ...inner, type: [inner.type as string, "null"], ...(s.description ? { description: s.description } : {}) };
    }
    default:
      return withDesc({});
  }
}

export function openAiTools(channel: ToolChannel) {
  return TOOLS.map((t) => ({ type: "function" as const, function: { name: t.name, description: `${t.description}${channel === "chat" ? "" : ""}`, parameters: toJsonSchema(t.schema) } }));
}
