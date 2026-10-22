import type { AppContext } from "./context.ts";
import { BatchService, defaultBatchConfig, type Actor, type BatchCheck, type BatchConfig, type BatchEstimate, type BatchPromptInput } from "./batches.ts";
import { resolveFbTarget } from "./fbreels/config.ts";
import { PromptService } from "./promptgen.ts";
import { AppError } from "./util.ts";

/**
 * TRIỂN KHAI bộ prompt thành video: mỗi prompt = đúng 1 video (N prompt → N video).
 *
 * Luồng: sinh bộ prompt (AI) → người dùng bấm "Triển khai" →
 * tạo batch từ bộ prompt (variantsPerPrompt luôn = 1) → chạy.
 *
 * Luật chi phí giữ nguyên như batch thường:
 *  - dryRun: chỉ kiểm + ước tính, không tạo gì.
 *  - run.confirm=true: duyệt luôn (approveBatch vẫn đòi approvedMaxCost ≥ ước tính /
 *    acknowledgeUnknownCost khi không ước tính được).
 *  - autoRunIfFree: provider miễn phí (Mock) thì tự chạy, provider tính phí thì dừng ở CHỜ DUYỆT.
 */

export type DeploySelection = "auto" | "approved" | "all";

export interface DeployArgs {
  sessionId?: string | null;
  providerConfigId?: string | null;
  modelId?: string | null;
  config?: Partial<BatchConfig>;
  /** auto = prompt đã duyệt nếu có, không thì mọi prompt chưa bị loại */
  selection?: DeploySelection;
  /** Giữ thời lượng/tỷ lệ riêng của từng prompt (mặc định có) */
  useItemOverrides?: boolean;
  /** Negative áp cho prompt chưa có negative riêng (chỉ khi model hỗ trợ) */
  defaultNegative?: string | null;
  maxConcurrency?: number;
  budgetLimit?: number | null;
  name?: string;
  dryRun?: boolean;
  run?: { confirm: boolean; approvedMaxCost?: number | null; acknowledgeUnknownCost?: boolean } | null;
  autoRunIfFree?: boolean;
  /** Đăng lên Page: id Page | "none". Bắt buộc khi tạo thật và đã có >=1 Page (dryRun không ép) */
  fbPage?: string | null;
}

export interface DeployResult {
  dryRun: boolean;
  promptSetId: string;
  promptSetName: string;
  selection: DeploySelection;
  /** Số prompt được dùng = số video */
  promptCount: number;
  videoCount: number;
  promptIndexes: number[];
  providerConfigId: string;
  modelId: string;
  free: boolean;
  check: BatchCheck;
  estimate: BatchEstimate;
  batch: ReturnType<BatchService["batchToPublic"]> | null;
  approved: boolean;
  approveError: { code: string; message: string } | null;
}

interface SetItem {
  id: string;
  index: number;
  title: string;
  prompt: string;
  negative: string | null;
  durationSec: number | null;
  aspectRatio: string | null;
  referenceAssetIds: string[];
  approval: string;
}

export function selectDeployItems<T extends { approval: string }>(items: T[], selection: DeploySelection): T[] {
  const approved = items.filter((i) => i.approval === "approved");
  const notRejected = items.filter((i) => i.approval !== "rejected");
  if (selection === "approved") return approved;
  if (selection === "all") return notRejected;
  return approved.length ? approved : notRejected;
}

export class DeployService {
  private ctx: AppContext;
  private batches: BatchService;
  private prompts: PromptService;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.batches = new BatchService(ctx);
    this.prompts = new PromptService(ctx);
  }

  /** Provider/model: tham số > provider/model lúc sinh bộ prompt > provider đang bật (ưu tiên provider thật) */
  private target(workspaceId: string, params: Record<string, unknown>, args: DeployArgs): { providerConfigId: string; modelId: string } {
    const enabled = this.ctx.providers.list(workspaceId).filter((p) => p.enabled);
    const fromParams = typeof params.providerConfigId === "string" ? enabled.find((p) => p.id === params.providerConfigId) : undefined;
    const p = args.providerConfigId
      ? enabled.find((x) => x.id === args.providerConfigId)
      : (fromParams ?? enabled.find((x) => x.status === "active" && x.providerType !== "mock") ?? enabled.find((x) => x.status === "active"));
    if (!p) throw new AppError(args.providerConfigId ? "NOT_FOUND" : "NO_PROVIDER", args.providerConfigId ? "Không tìm thấy provider đang bật với id này." : "Chưa có provider video nào đang bật (trang Provider).", args.providerConfigId ? 404 : 409);
    const paramModel = p.id === params.providerConfigId && typeof params.modelId === "string" ? params.modelId : null;
    const modelId = args.modelId ?? paramModel ?? p.defaultModelId ?? p.capabilities.models[0]?.modelId;
    if (!modelId) throw new AppError("NO_MODEL", "Provider chưa có model.", 409);
    return { providerConfigId: p.id, modelId };
  }

  deploy(workspaceId: string, actor: Actor, promptSetId: string, args: DeployArgs = {}): DeployResult {
    const set = this.prompts.getSet(workspaceId, promptSetId);
    const selection: DeploySelection = args.selection ?? "auto";
    const items = selectDeployItems(set.items as SetItem[], selection);
    if (!items.length) {
      throw new AppError(
        "NO_PROMPTS",
        selection === "approved" ? "Bộ prompt chưa có prompt nào được duyệt - duyệt prompt hoặc chọn dùng mọi prompt chưa bị loại." : "Bộ prompt không còn prompt nào để triển khai (đã loại hết).",
        400,
      );
    }
    const params = (set.params ?? {}) as Record<string, unknown>;
    const { providerConfigId, modelId } = this.target(workspaceId, params, args);

    // N prompt → N video: luôn 1 lần tạo cho mỗi prompt
    const cfgIn: Partial<BatchConfig> = { ...(args.config ?? {}) };
    if (cfgIn.durationSec === undefined && typeof params.durationSec === "number") cfgIn.durationSec = params.durationSec;
    if (cfgIn.aspectRatio === undefined && typeof params.aspectRatio === "string") cfgIn.aspectRatio = params.aspectRatio;
    cfgIn.variantsPerPrompt = 1;

    const keepOverrides = args.useItemOverrides !== false;
    const neg = args.defaultNegative?.trim() || null;
    const prompts: BatchPromptInput[] = items.map((i) => ({
      prompt: i.prompt,
      title: i.title || undefined,
      negative: i.negative ?? neg,
      durationSec: keepOverrides ? i.durationSec : null,
      aspectRatio: keepOverrides ? i.aspectRatio : null,
      referenceAssetIds: i.referenceAssetIds?.length ? i.referenceAssetIds : undefined,
      promptItemId: i.id,
    }));
    const lines = items.map((i) => i.index);
    const free = this.ctx.providers.get(workspaceId, providerConfigId).capabilities.pricing === "free-mock";
    const base = { dryRun: Boolean(args.dryRun), promptSetId: set.id, promptSetName: set.name, selection, promptCount: items.length, promptIndexes: lines, providerConfigId, modelId, free };

    if (args.dryRun) {
      resolveFbTarget(this.ctx, workspaceId, args.fbPage, false); // chỉ kiểm giá trị nếu có, không ép chọn
      const full = defaultBatchConfig({ ...cfgIn, variantsPerPrompt: 1 });
      const check = this.batches.check(workspaceId, { providerConfigId, modelId, config: full, prompts, lines });
      const maxConcurrency = Math.max(1, Math.min(64, Math.round(args.maxConcurrency ?? 2)));
      const budgetLimit = args.budgetLimit === undefined || args.budgetLimit === null || !Number.isFinite(Number(args.budgetLimit)) ? null : Number(args.budgetLimit);
      const estimate = this.batches.estimate(workspaceId, { providerConfigId, modelId, config: full, prompts, maxConcurrency, budgetLimit });
      return { ...base, videoCount: check.jobCount, check, estimate, batch: null, approved: false, approveError: null };
    }

    const created = this.batches.createBatch(workspaceId, actor, {
      sessionId: args.sessionId !== undefined ? args.sessionId : set.sessionId,
      name: args.name?.trim() || `Triển khai: ${set.name}`.slice(0, 120),
      mode: set.source === "ai" ? "ai" : "list",
      promptSetId: set.id,
      providerConfigId,
      modelId,
      config: cfgIn,
      prompts,
      lines,
      maxConcurrency: args.maxConcurrency,
      budgetLimit: args.budgetLimit ?? null,
      fbPage: args.fbPage ?? null,
    });
    const jobs = Number(this.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_batch_jobs WHERE batch_id = ?", created.batch.id)?.n ?? 0);
    if (jobs !== items.length) throw new AppError("DEPLOY_COUNT_MISMATCH", `Lỗi nội bộ: ${items.length} prompt nhưng tạo ${jobs} job.`, 500);

    let run = args.run ?? null;
    if (!run?.confirm && args.autoRunIfFree && free) run = { confirm: true, approvedMaxCost: 0 };
    let approved = false;
    let approveError: DeployResult["approveError"] = null;
    if (run?.confirm) {
      try {
        this.batches.approveBatch(workspaceId, actor, created.batch.id, { confirm: true, approvedMaxCost: run.approvedMaxCost ?? null, acknowledgeUnknownCost: run.acknowledgeUnknownCost === true });
        approved = true;
      } catch (e) {
        const err = e as AppError;
        approveError = { code: err.code ?? "ERROR", message: err.message };
      }
    }
    return {
      ...base,
      videoCount: jobs,
      check: created.check,
      estimate: created.estimate,
      batch: this.batches.batchToPublic(this.batches.getBatchRow(workspaceId, created.batch.id)),
      approved,
      approveError,
    };
  }
}

