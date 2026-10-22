import type { AppContext } from "./context.ts";
import { audit, eventToPublic, recordEvent, type EventRow } from "./events.ts";
import type { CostEstimate, GenerationInput, GenerationMode, ValidationIssue } from "./providers/types.ts";
import { checkList, type ParsedLine, type PromptDraft } from "./prompts.ts";
import { pageName, resolveFbTarget } from "./fbreels/config.ts";
import { normalizeShopeeUrl } from "./fbreels/shopee.ts";
import { AppError, durationFromPrompt, newId, nowIso, safeJsonParse } from "./util.ts";

export const JOB_STATUSES = ["draft", "awaiting_approval", "queued", "waiting_for_capacity", "submitting", "processing", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: JobStatus[] = ["submitting", "processing"];
export const PENDING_JOB_STATUSES: JobStatus[] = ["draft", "awaiting_approval", "queued", "waiting_for_capacity"];
export const TERMINAL_JOB_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];

export type BatchStatus = "draft" | "awaiting_approval" | "running" | "paused" | "completed" | "cancelled";

export interface BatchConfig {
  mode: GenerationMode;
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  quality: string | null;
  variantsPerPrompt: number;
  /** Ảnh sản phẩm / nhân vật tham chiếu dùng chung cho mọi prompt của batch */
  referenceAssetIds: string[];
  maxAttempts: number;
}

export interface Actor {
  userId: string | null;
  kind: "ui" | "api-token" | "mcp" | "chat" | "system";
}

export interface JobRow {
  id: string;
  batch_id: string;
  workspace_id: string;
  session_id: string | null;
  seq: number;
  prompt_item_id: string | null;
  title: string;
  prompt: string;
  negative: string | null;
  reference_asset_ids_json: string;
  provider_config_id: string;
  model_id: string;
  config_json: string;
  status: JobStatus;
  attempt: number;
  max_attempts: number;
  manual_retries: number;
  idempotency_key: string | null;
  resubmit_same_key: number;
  transient_failures: number;
  remote_job_id: string | null;
  next_attempt_at: number;
  next_poll_at: number;
  poll_failures: number;
  lease_owner: string | null;
  lease_until: number | null;
  cancel_requested: number;
  progress: number | null;
  error_code: string | null;
  error_message: string | null;
  error_detail: string | null;
  output_asset_id: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  lineage_id: string;
  version: number;
  parent_job_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  completed_at: string | null;
}

export interface BatchRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  name: string;
  mode: string;
  prompt_set_id: string | null;
  provider_config_id: string;
  model_id: string;
  config_json: string;
  max_concurrency: number;
  status: BatchStatus;
  budget_limit: number | null;
  estimate_json: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  currency: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approved_max_cost: number | null;
  created_by: string | null;
  /** NULL = không có Page nào lúc tạo; 'none' = chọn rõ không đăng; còn lại = fb_pages.id */
  fb_page_id: string | null;
  shopee_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface BatchPromptInput extends PromptDraft {
  promptItemId?: string | null;
}

export interface ItemReport {
  index: number;
  line: number | null;
  prompt: string;
  issues: ValidationIssue[];
  duplicateOf: number | null;
  valid: boolean;
}

export interface BatchCheck {
  totalLines: number;
  blankLines: number[];
  validPrompts: number;
  invalidPrompts: number;
  duplicateCount: number;
  nearDuplicates: { line: number; similarToLine: number; score: number }[];
  variantsPerPrompt: number;
  jobCount: number;
  /** "50 dòng → 50 video" */
  summary: string;
  items: ItemReport[];
  batchIssues: ValidationIssue[];
  ok: boolean;
}

export interface BatchEstimate {
  jobCount: number;
  perJob: { index: number; amount: number | null; basis: string }[];
  total: number | null;
  currency: string;
  kind: CostEstimate["kind"];
  basis: string;
  budgetLimit: number | null;
  withinBudget: boolean | null;
  effectiveConcurrency: number;
  providerConcurrency: number;
  notes: string[];
}

export function defaultBatchConfig(partial: Partial<BatchConfig> = {}): BatchConfig {
  return {
    mode: partial.mode ?? "text-to-video",
    durationSec: partial.durationSec ?? 8,
    aspectRatio: partial.aspectRatio ?? "9:16",
    resolution: partial.resolution ?? "720p",
    audio: partial.audio ?? false,
    quality: partial.quality ?? null,
    variantsPerPrompt: Math.max(1, Math.min(10, Math.round(partial.variantsPerPrompt ?? 1))),
    referenceAssetIds: partial.referenceAssetIds ?? [],
    maxAttempts: Math.max(1, Math.min(6, Math.round(partial.maxAttempts ?? 3))),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export class BatchService {
  private ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  private get db() {
    return this.ctx.db;
  }

  // ---------------------------------------------------------------- input chuẩn

  /** Ghép cấu hình batch + ghi đè riêng của từng prompt → input chuẩn gửi provider */
  buildInput(workspaceId: string, modelId: string, cfg: BatchConfig, p: { prompt: string; negative?: string | null; durationSec?: number | null; aspectRatio?: string | null; referenceAssetIds?: string[] }): GenerationInput {
    const refIds = [...new Set([...(cfg.referenceAssetIds ?? []), ...(p.referenceAssetIds ?? [])])];
    const referenceImages = refIds.map((id) => {
      const a = this.ctx.storage.getRow(workspaceId, id);
      if (a.kind !== "image") throw new AppError("REFERENCE_NOT_IMAGE", `Asset ${id} không phải ảnh - chỉ ảnh mới làm tham chiếu được.`, 400);
      return { path: this.ctx.storage.abs(a.storage_path), mime: a.mime };
    });
    return {
      modelId,
      mode: cfg.mode,
      prompt: p.prompt.trim(),
      negativePrompt: p.negative?.trim() || null,
      durationSec: p.durationSec ?? cfg.durationSec,
      aspectRatio: p.aspectRatio ?? cfg.aspectRatio,
      resolution: cfg.resolution,
      audio: cfg.audio,
      quality: cfg.quality,
      referenceImages,
    };
  }

  // ---------------------------------------------------------------- kiểm + ước tính

  check(workspaceId: string, args: { providerConfigId: string; modelId: string; config: BatchConfig; prompts: BatchPromptInput[]; blankLines?: number[]; lines?: (number | null)[] }): BatchCheck {
    const { config: provCfg, adapter, row } = this.ctx.providers.resolveById(workspaceId, args.providerConfigId);
    const batchIssues: ValidationIssue[] = [];
    if (!row.enabled) batchIssues.push({ field: "provider", code: "PROVIDER_DISABLED", message: "Provider đang tắt." });
    const caps = adapter.getCapabilities(provCfg);
    if (!caps.models.some((m) => m.modelId === args.modelId)) batchIssues.push({ field: "modelId", code: "MODEL_NOT_AVAILABLE", message: `Model "${args.modelId}" không có trong provider này.` });

    const parsed: ParsedLine[] = args.prompts.map((p, i) => ({ line: args.lines?.[i] ?? i + 1, draft: p }));
    const list = checkList(parsed, args.blankLines ?? []);
    const dupMap = new Map(list.duplicates.map((d) => [d.line, d.duplicateOfLine]));

    const items: ItemReport[] = args.prompts.map((p, i) => {
      const line = parsed[i]!.line;
      let issues: ValidationIssue[] = [];
      try {
        issues = adapter.validateInput(this.buildInput(workspaceId, args.modelId, args.config, p), provCfg);
      } catch (e) {
        issues = [{ field: "referenceImages", code: (e as AppError).code ?? "INVALID", message: (e as Error).message }];
      }
      // Lỗi cấp provider (thiếu key...) báo một lần ở batchIssues, không lặp 50 lần
      const providerLevel = issues.filter((x) => x.field === "provider");
      for (const pl of providerLevel) if (!batchIssues.some((b) => b.code === pl.code)) batchIssues.push(pl);
      issues = issues.filter((x) => x.field !== "provider");
      const duplicateOf = dupMap.get(line) ?? null;
      if (duplicateOf !== null) issues.push({ field: "prompt", code: "DUPLICATE", message: `Trùng với dòng ${duplicateOf}.` });
      return { index: i, line, prompt: p.prompt, issues, duplicateOf, valid: issues.length === 0 };
    });

    const variants = args.config.variantsPerPrompt;
    const valid = items.filter((x) => x.valid).length;
    const jobCount = valid * variants;
    const summary = variants > 1 ? `${valid} prompt hợp lệ × ${variants} lần tạo → ${jobCount} video` : `${valid} dòng → ${jobCount} video`;
    return {
      totalLines: list.totalLines,
      blankLines: list.blankLines,
      validPrompts: valid,
      invalidPrompts: items.length - valid,
      duplicateCount: list.duplicates.length,
      nearDuplicates: list.nearDuplicates,
      variantsPerPrompt: variants,
      jobCount,
      summary,
      items,
      batchIssues,
      ok: batchIssues.length === 0 && valid > 0 && items.every((x) => x.valid),
    };
  }

  estimate(workspaceId: string, args: { providerConfigId: string; modelId: string; config: BatchConfig; prompts: BatchPromptInput[]; maxConcurrency: number; budgetLimit: number | null }): BatchEstimate {
    const { config: provCfg, adapter } = this.ctx.providers.resolveById(workspaceId, args.providerConfigId);
    const perJob: BatchEstimate["perJob"] = [];
    let total: number | null = 0;
    let kind: CostEstimate["kind"] = "free-mock";
    let currency = "USD";
    let basis = "";
    let idx = 0;
    for (const p of args.prompts) {
      const input = this.buildInput(workspaceId, args.modelId, args.config, p);
      const est = adapter.estimateCost(input, provCfg);
      currency = est.currency;
      basis = est.basis;
      if (est.kind === "unknown") kind = "unknown";
      else if (est.kind === "user-configured" && kind !== "unknown") kind = "user-configured";
      for (let v = 0; v < args.config.variantsPerPrompt; v++) {
        perJob.push({ index: idx++, amount: est.amount, basis: est.basis });
        if (est.amount === null) total = null;
        else if (total !== null) total = round4(total + est.amount);
      }
    }
    const providerConcurrency = provCfg.maxConcurrency;
    const effective = Math.max(1, Math.min(args.maxConcurrency, providerConcurrency));
    const notes: string[] = [];
    if (args.maxConcurrency > providerConcurrency)
      notes.push(`Bạn chọn ${args.maxConcurrency} luồng nhưng provider chỉ cho ${providerConcurrency} → hệ thống chạy tối đa ${providerConcurrency} job cùng lúc.`);
    if (kind === "unknown") notes.push("Chưa có đơn giá đáng tin cậy cho provider này → không ước tính được chi phí. Nhập đơn giá ở trang Provider để bật kiểm soát ngân sách.");
    if (kind === "free-mock") notes.push("Mock provider: không tính phí, video là video kiểm thử (không phải video AI).");
    return {
      jobCount: perJob.length,
      perJob,
      total,
      currency,
      kind,
      basis,
      budgetLimit: args.budgetLimit,
      withinBudget: args.budgetLimit === null ? null : total === null ? null : total <= args.budgetLimit,
      effectiveConcurrency: effective,
      providerConcurrency,
      notes,
    };
  }

  // ---------------------------------------------------------------- tạo / duyệt

  createBatch(
    workspaceId: string,
    actor: Actor,
    args: {
      sessionId?: string | null;
      name?: string;
      mode: "single" | "list" | "file" | "ai";
      promptSetId?: string | null;
      providerConfigId: string;
      modelId: string;
      config: Partial<BatchConfig>;
      prompts: BatchPromptInput[];
      blankLines?: number[];
      lines?: (number | null)[];
      maxConcurrency?: number;
      budgetLimit?: number | null;
      /** Đăng lên Page: id Page Facebook đã cấu hình | "none" (không đăng). BẮT BUỘC khi đã có >=1 Page */
      fbPage?: string | null;
      /** Link Shopee của sản phẩm (1 link/batch), chỉ khi đăng lên một Page */
      shopeeUrl?: string | null;
    },
  ): { batch: BatchRow; check: BatchCheck; estimate: BatchEstimate } {
    // Luật ép chọn Page nằm ở đây (điểm nghẽn duy nhất của mọi đường tạo batch: API, deploy, tool, MCP, chat)
    const fbTarget = resolveFbTarget(this.ctx, workspaceId, args.fbPage);
    const shopeeUrl = normalizeShopeeUrl(args.shopeeUrl);
    if (shopeeUrl && (!fbTarget || fbTarget === "none")) throw new AppError("SHOPEE_NEEDS_PAGE", "Chỉ nhập link Shopee khi batch đăng lên một Page Facebook.", 400);
    const config = defaultBatchConfig(args.config);
    // Thời lượng nghe theo prompt: prompt ghi "dài N giây" thì job đó dùng N (nếu model hỗ trợ), không thì theo cấu hình
    {
      const caps = this.ctx.providers.resolveById(workspaceId, args.providerConfigId).adapter.getCapabilities(this.ctx.providers.resolveById(workspaceId, args.providerConfigId).config).models.find((m) => m.modelId === args.modelId);
      const lo = caps?.durations.min ?? 1;
      const hi = caps?.durations.max ?? 600;
      args.prompts = args.prompts.map((p) => (p.durationSec ? p : { ...p, durationSec: durationFromPrompt(p.prompt, lo, hi) ?? p.durationSec }));
    }
    if (args.sessionId) this.assertSession(workspaceId, args.sessionId);
    if (!args.prompts.length) throw new AppError("NO_PROMPTS", "Chưa có prompt nào.", 400);
    if (args.prompts.length * config.variantsPerPrompt > 1000) throw new AppError("BATCH_TOO_LARGE", "Một batch tối đa 1000 video.", 400);
    const check = this.check(workspaceId, { providerConfigId: args.providerConfigId, modelId: args.modelId, config, prompts: args.prompts, blankLines: args.blankLines, lines: args.lines });
    if (!check.ok) throw new AppError("BATCH_INVALID", "Danh sách prompt/cấu hình chưa hợp lệ - sửa các lỗi trước khi tạo batch (chưa gọi provider).", 422, check);
    const maxConcurrency = Math.max(1, Math.min(64, Math.round(args.maxConcurrency ?? 2)));
    const budgetLimit = args.budgetLimit === undefined || args.budgetLimit === null || !Number.isFinite(Number(args.budgetLimit)) ? null : Number(args.budgetLimit);
    const estimate = this.estimate(workspaceId, { providerConfigId: args.providerConfigId, modelId: args.modelId, config, prompts: args.prompts, maxConcurrency, budgetLimit });
    if (budgetLimit !== null && estimate.total !== null && estimate.total > budgetLimit)
      throw new AppError("BUDGET_EXCEEDED", `Chi phí ước tính ${estimate.total} ${estimate.currency} vượt ngân sách ${budgetLimit} ${estimate.currency} - giảm số video/thời lượng hoặc tăng ngân sách.`, 409, estimate);

    const batchId = newId("bat");
    const now = nowIso();
    const name = args.name?.trim() || `Batch ${new Date().toLocaleString("vi-VN")}`;
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO video_batches (id, workspace_id, session_id, name, mode, prompt_set_id, provider_config_id, model_id, config_json, max_concurrency, status,
           budget_limit, estimate_json, estimated_cost, actual_cost, currency, created_by, fb_page_id, shopee_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        batchId,
        workspaceId,
        args.sessionId ?? null,
        name,
        args.mode,
        args.promptSetId ?? null,
        args.providerConfigId,
        args.modelId,
        JSON.stringify(config),
        maxConcurrency,
        budgetLimit,
        JSON.stringify({ ...estimate, perJob: undefined }),
        estimate.total,
        estimate.currency,
        actor.userId,
        fbTarget,
        shopeeUrl,
        now,
        now,
      );
      let seq = 0;
      args.prompts.forEach((p) => {
        for (let v = 0; v < config.variantsPerPrompt; v++) {
          const jobId = newId("job");
          const est = estimate.perJob[seq]?.amount ?? null;
          seq++;
          this.db.run(
            `INSERT INTO video_batch_jobs (id, batch_id, workspace_id, session_id, seq, prompt_item_id, title, prompt, negative, reference_asset_ids_json,
               provider_config_id, model_id, config_json, status, max_attempts, estimated_cost, lineage_id, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, 1, ?, ?)`,
            jobId,
            batchId,
            workspaceId,
            args.sessionId ?? null,
            seq,
            p.promptItemId ?? null,
            (p.title ?? "").slice(0, 200) + (config.variantsPerPrompt > 1 ? ` (#${v + 1})` : ""),
            p.prompt.trim(),
            p.negative?.trim() || null,
            JSON.stringify(p.referenceAssetIds ?? []),
            args.providerConfigId,
            args.modelId,
            JSON.stringify({ ...config, durationSec: p.durationSec ?? config.durationSec, aspectRatio: p.aspectRatio ?? config.aspectRatio }),
            config.maxAttempts,
            est,
            jobId,
            now,
            now,
          );
        }
      });
      recordEvent(this.db, { workspaceId, type: "batch.created", batchId, to: "awaiting_approval", message: `${seq} job chờ duyệt`, data: { jobCount: seq, estimate: estimate.total } });
      audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "batch.create", targetType: "batch", targetId: batchId, data: { jobCount: seq, estimatedCost: estimate.total, provider: args.providerConfigId, model: args.modelId } });
    });
    return { batch: this.getBatchRow(workspaceId, batchId), check, estimate };
  }

  /**
   * Duyệt + chạy batch. Bắt buộc confirm=true. Chi phí xác định → approvedMaxCost
   * phải ≥ ước tính hiện tại. Chi phí không xác định → acknowledgeUnknownCost.
   */
  approveBatch(workspaceId: string, actor: Actor, batchId: string, opts: { confirm: boolean; approvedMaxCost?: number | null; acknowledgeUnknownCost?: boolean }): BatchRow {
    const b = this.getBatchRow(workspaceId, batchId);
    if (b.status !== "awaiting_approval") throw new AppError("BATCH_NOT_AWAITING_APPROVAL", `Batch đang ở trạng thái "${b.status}", không cần duyệt.`, 409);
    if (opts.confirm !== true) throw new AppError("CONFIRMATION_REQUIRED", "Cần xác nhận rõ ràng (confirm=true) trước khi chạy batch.", 409);
    const waiting = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_batch_jobs WHERE batch_id = ? AND status = 'awaiting_approval'", batchId)?.n ?? 0);
    if (waiting === 0) {
      this.refreshBatch(batchId);
      throw new AppError("NOTHING_TO_APPROVE", "Batch không còn job nào chờ duyệt (đã hủy hết).", 409);
    }
    const est = this.reestimate(b);
    if (b.budget_limit !== null) {
      if (est.total === null && !opts.acknowledgeUnknownCost)
        throw new AppError("BUDGET_UNVERIFIABLE", "Batch có ngân sách nhưng provider chưa có đơn giá → không kiểm được ngân sách. Nhập đơn giá hoặc xác nhận chấp nhận chi phí không xác định.", 409, est);
      if (est.total !== null && est.total > b.budget_limit) throw new AppError("BUDGET_EXCEEDED", `Chi phí ước tính ${est.total} vượt ngân sách ${b.budget_limit}.`, 409, est);
    }
    if (est.total !== null && est.total > 0) {
      const max = Number(opts.approvedMaxCost);
      if (!Number.isFinite(max) || max < est.total)
        throw new AppError("COST_CONFIRMATION_MISMATCH", `Chi phí ước tính hiện tại là ${est.total} ${est.currency} - xác nhận với mức tối đa ≥ con số này.`, 409, est);
    }
    if (est.total === null && !opts.acknowledgeUnknownCost)
      throw new AppError("COST_UNKNOWN_ACK_REQUIRED", "Không ước tính được chi phí (chưa có đơn giá). Cần xác nhận chấp nhận chi phí không xác định.", 409, est);
    const now = nowIso();
    this.db.tx(() => {
      this.db.run(
        `UPDATE video_batches SET status = 'running', approved_by = ?, approved_at = ?, approved_max_cost = ?, estimated_cost = ?, updated_at = ? WHERE id = ?`,
        actor.userId,
        now,
        opts.approvedMaxCost ?? est.total,
        est.total,
        now,
        batchId,
      );
      const n = this.db.run("UPDATE video_batch_jobs SET status = 'queued', next_attempt_at = 0, updated_at = ? WHERE batch_id = ? AND status = 'awaiting_approval'", now, batchId).changes;
      recordEvent(this.db, { workspaceId, type: "batch.approved", batchId, from: "awaiting_approval", to: "running", message: `${n} job vào hàng đợi` });
      audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "batch.approve", targetType: "batch", targetId: batchId, data: { estimatedCost: est.total, approvedMaxCost: opts.approvedMaxCost ?? null, unknownCostAcknowledged: Boolean(opts.acknowledgeUnknownCost) } });
    });
    return this.getBatchRow(workspaceId, batchId);
  }

  /** Ước tính lại cho các job đang chờ duyệt của batch (giá có thể đã đổi) */
  reestimate(b: BatchRow, onlyJobIds?: string[]): BatchEstimate {
    const jobs = this.db
      .all<JobRow>("SELECT * FROM video_batch_jobs WHERE batch_id = ? AND status = 'awaiting_approval' ORDER BY seq", b.id)
      .filter((j) => !onlyJobIds || onlyJobIds.includes(j.id));
    const cfg = safeJsonParse<BatchConfig>(b.config_json, defaultBatchConfig());
    return this.estimate(b.workspace_id, {
      providerConfigId: b.provider_config_id,
      modelId: b.model_id,
      config: { ...cfg, variantsPerPrompt: 1 },
      prompts: jobs.map((j) => {
        const jc = safeJsonParse<BatchConfig>(j.config_json, cfg);
        return { prompt: j.prompt, negative: j.negative, durationSec: jc.durationSec, aspectRatio: jc.aspectRatio, referenceAssetIds: safeJsonParse<string[]>(j.reference_asset_ids_json, []) };
      }),
      maxConcurrency: b.max_concurrency,
      budgetLimit: b.budget_limit,
    });
  }

  setMaxConcurrency(workspaceId: string, actor: Actor, batchId: string, n: number): BatchRow {
    const b = this.getBatchRow(workspaceId, batchId);
    const v = Math.max(1, Math.min(64, Math.round(Number(n))));
    if (!Number.isFinite(v)) throw new AppError("INVALID_CONCURRENCY", "Số luồng không hợp lệ.", 400);
    this.db.run("UPDATE video_batches SET max_concurrency = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", v, nowIso(), batchId, workspaceId);
    audit(this.ctx.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "batch.concurrency", targetType: "batch", targetId: batchId, data: { from: b.max_concurrency, to: v } });
    return this.getBatchRow(workspaceId, batchId);
  }

  setBatchStatus(workspaceId: string, actor: Actor, batchId: string, action: "pause" | "resume"): BatchRow {
    const b = this.getBatchRow(workspaceId, batchId);
    if (action === "pause") {
      if (b.status !== "running") throw new AppError("BATCH_NOT_RUNNING", "Chỉ tạm dừng được batch đang chạy.", 409);
      this.db.run("UPDATE video_batches SET status = 'paused', updated_at = ? WHERE id = ?", nowIso(), batchId);
      recordEvent(this.db, { workspaceId, type: "batch.paused", batchId, from: "running", to: "paused", message: "Tạm dừng: không gửi job mới; job đang chạy ở provider vẫn được theo dõi tới khi xong." });
    } else {
      if (b.status !== "paused") throw new AppError("BATCH_NOT_PAUSED", "Batch không ở trạng thái tạm dừng.", 409);
      this.db.run("UPDATE video_batches SET status = 'running', updated_at = ? WHERE id = ?", nowIso(), batchId);
      recordEvent(this.db, { workspaceId, type: "batch.resumed", batchId, from: "paused", to: "running" });
    }
    audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: `batch.${action}`, targetType: "batch", targetId: batchId });
    this.refreshBatch(batchId);
    return this.getBatchRow(workspaceId, batchId);
  }

  // ---------------------------------------------------------------- hủy / tạo lại

  /**
   * Hủy MỘT job. Chưa gửi → hủy ngay. Đang chạy ở provider → chỉ hủy khi
   * provider hỗ trợ (vd Seedance chỉ hủy được task còn xếp hàng). Không đụng job khác.
   */
  async cancelJob(workspaceId: string, actor: Actor, jobId: string): Promise<{ job: JobRow; cancelled: boolean; message: string }> {
    const j = this.getJobRow(workspaceId, jobId);
    if (TERMINAL_JOB_STATUSES.includes(j.status)) return { job: j, cancelled: false, message: `Job đã ở trạng thái ${j.status}.` };
    if (PENDING_JOB_STATUSES.includes(j.status)) {
      const changed = this.transition(j, "cancelled", { error_code: null, error_message: "Đã hủy trước khi gửi provider." }, ["draft", "awaiting_approval", "queued", "waiting_for_capacity"]);
      if (changed) {
        audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "job.cancel", targetType: "job", targetId: jobId });
        return { job: this.getJobRow(workspaceId, jobId), cancelled: true, message: "Đã hủy job (chưa gửi provider, không tốn phí)." };
      }
      return this.cancelJob(workspaceId, actor, jobId); // vừa đổi trạng thái - xét lại
    }
    if (j.status === "submitting") {
      this.db.run("UPDATE video_batch_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?", nowIso(), jobId);
      return { job: this.getJobRow(workspaceId, jobId), cancelled: false, message: "Job đang được gửi - sẽ hủy ngay sau khi provider nhận (nếu provider hỗ trợ hủy)." };
    }
    // processing
    const { config, adapter } = this.ctx.providers.resolveById(workspaceId, j.provider_config_id);
    const caps = adapter.getCapabilities(config);
    if (caps.cancel === "none" || !adapter.cancelGeneration || !j.remote_job_id)
      throw new AppError("CANCEL_UNSUPPORTED", "Provider không hỗ trợ hủy job đang chạy - job vẫn tiếp tục và có thể tính phí.", 409);
    try {
      await adapter.cancelGeneration(j.remote_job_id, { config, idempotencyKey: j.idempotency_key ?? j.id, workDir: this.ctx.storage.tmpDir("provider", config.id), log: () => {} });
    } catch (e) {
      throw new AppError("CANCEL_REJECTED", `Provider không hủy được job (${caps.cancel === "queued_only" ? "chỉ hủy được khi còn xếp hàng" : "từ chối"}): ${(e as Error).message}`, 409);
    }
    this.transition(j, "cancelled", { error_message: "Đã hủy ở provider." }, ["processing"]);
    audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "job.cancel", targetType: "job", targetId: jobId, data: { remote: true } });
    return { job: this.getJobRow(workspaceId, jobId), cancelled: true, message: "Đã hủy job ở provider." };
  }

  /** Hủy mọi job CHƯA gửi của batch (không đụng job đang chạy / đã xong) */
  cancelPending(workspaceId: string, actor: Actor, batchId: string): number {
    this.getBatchRow(workspaceId, batchId);
    const now = nowIso();
    const ids = this.db.all<{ id: string; status: string }>(`SELECT id, status FROM video_batch_jobs WHERE batch_id = ? AND status IN ('draft','awaiting_approval','queued','waiting_for_capacity')`, batchId);
    let n = 0;
    this.db.tx(() => {
      for (const r of ids) {
        const c = this.db.run(`UPDATE video_batch_jobs SET status = 'cancelled', error_message = 'Đã hủy (hủy các job chưa chạy).', updated_at = ? WHERE id = ? AND status = ?`, now, r.id, r.status).changes;
        if (c) {
          n++;
          recordEvent(this.db, { workspaceId, type: "job.status", batchId, jobId: r.id, from: r.status, to: "cancelled" });
        }
      }
      audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "batch.cancel_pending", targetType: "batch", targetId: batchId, data: { cancelled: n } });
    });
    this.refreshBatch(batchId);
    return n;
  }

  /**
   * XÓA HẲN batch: job + sự kiện + video đã tạo (asset) của batch.
   * Chặn khi còn job đang gửi/đang chạy ở provider (phải hủy trước, nếu không
   * worker sẽ tải kết quả về cho một batch không còn tồn tại).
   * `keepAssets=true` chỉ xóa batch/job, video vẫn nằm trong Thư viện.
   */
  deleteBatch(workspaceId: string, actor: Actor, batchId: string, opts: { keepAssets?: boolean } = {}): { batchId: string; jobsDeleted: number; assetsDeleted: number; freedBytes: number } {
    const b = this.getBatchRow(workspaceId, batchId);
    const active = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM video_batch_jobs WHERE batch_id = ? AND status IN ('submitting','processing')`, batchId);
    if (Number(active?.n ?? 0) > 0) throw new AppError("BATCH_ACTIVE", `Batch còn ${active!.n} job đang chạy ở provider - hủy job đó trước khi xóa.`, 409);

    const assetIds = opts.keepAssets
      ? []
      : this.db.all<{ id: string }>("SELECT a.id FROM video_assets a JOIN video_batch_jobs j ON j.id = a.source_job_id WHERE j.batch_id = ? AND a.workspace_id = ?", batchId, workspaceId).map((r) => r.id);

    const del = assetIds.length ? this.ctx.storage.deleteAssets(workspaceId, assetIds, { skipInUse: true }) : { deleted: [], skipped: [], freedBytes: 0 };

    let jobsDeleted = 0;
    this.db.tx(() => {
      this.db.run("DELETE FROM generation_versions WHERE job_id IN (SELECT id FROM video_batch_jobs WHERE batch_id = ?)", batchId);
      jobsDeleted = this.db.run("DELETE FROM video_batch_jobs WHERE batch_id = ?", batchId).changes;
      this.db.run("DELETE FROM video_batches WHERE id = ? AND workspace_id = ?", batchId, workspaceId);
      this.db.run("DELETE FROM job_events WHERE batch_id = ?", batchId);
      audit(this.db, {
        workspaceId,
        userId: actor.userId,
        actor: actor.kind,
        action: "batch.delete",
        targetType: "batch",
        targetId: batchId,
        data: { name: b.name, jobs: jobsDeleted, assets: del.deleted.length, keepAssets: Boolean(opts.keepAssets), freedBytes: del.freedBytes },
      });
    });
    // Sự kiện ghi SAU khi xóa (batch_id chỉ còn là nhãn) để web tự tải lại danh sách
    recordEvent(this.db, { workspaceId, type: "batch.deleted", batchId, message: `Đã xóa batch "${b.name}" (${jobsDeleted} job, ${del.deleted.length} video).` });
    return { batchId, jobsDeleted, assetsDeleted: del.deleted.length, freedBytes: del.freedBytes };
  }

  /**
   * Tạo lại job lỗi/đã hủy (cùng phiên bản, lần thử mới). Có phí → cần confirm
   * và kiểm ngân sách: đã tiêu + ước tính phần tạo lại ≤ ngân sách.
   */
  retryJobs(workspaceId: string, actor: Actor, args: { batchId?: string; jobIds?: string[]; confirm: boolean; approvedMaxCost?: number | null; acknowledgeUnknownCost?: boolean }): { retried: string[]; estimate: number | null; skipped: { id: string; reason: string }[] } {
    let jobs: JobRow[];
    if (args.jobIds?.length) jobs = args.jobIds.map((id) => this.getJobRow(workspaceId, id));
    else if (args.batchId) {
      this.getBatchRow(workspaceId, args.batchId);
      jobs = this.db.all<JobRow>("SELECT * FROM video_batch_jobs WHERE batch_id = ? AND status = 'failed' ORDER BY seq", args.batchId);
    } else throw new AppError("NO_TARGET", "Cần batchId hoặc jobIds.", 400);
    const skipped: { id: string; reason: string }[] = [];
    const target = jobs.filter((j) => {
      if (j.status === "failed" || j.status === "cancelled") return true;
      skipped.push({ id: j.id, reason: `đang ở trạng thái ${j.status}` });
      return false;
    });
    if (!target.length) return { retried: [], estimate: 0, skipped };
    // Ước tính
    let total: number | null = 0;
    for (const j of target) {
      const { config, adapter } = this.ctx.providers.resolveById(workspaceId, j.provider_config_id);
      const jc = safeJsonParse<BatchConfig>(j.config_json, defaultBatchConfig());
      const est = adapter.estimateCost(this.buildInput(workspaceId, j.model_id, jc, { prompt: j.prompt, negative: j.negative, referenceAssetIds: safeJsonParse(j.reference_asset_ids_json, []) }), config);
      total = est.amount === null || total === null ? null : round4(total + est.amount);
    }
    if (!args.confirm) throw new AppError("CONFIRMATION_REQUIRED", `Tạo lại ${target.length} job${total === null ? " (chi phí không xác định)" : ` (ước tính ${total})`} - cần xác nhận.`, 409, { count: target.length, estimate: total });
    if (total === null && !args.acknowledgeUnknownCost) throw new AppError("COST_UNKNOWN_ACK_REQUIRED", "Không ước tính được chi phí tạo lại - cần xác nhận chấp nhận chi phí không xác định.", 409, { count: target.length });
    if (total !== null && total > 0 && !(Number(args.approvedMaxCost) >= total)) throw new AppError("COST_CONFIRMATION_MISMATCH", `Chi phí tạo lại ước tính ${total} - xác nhận với mức tối đa ≥ con số này.`, 409, { estimate: total });
    // Ngân sách theo batch
    const byBatch = new Map<string, JobRow[]>();
    for (const j of target) byBatch.set(j.batch_id, [...(byBatch.get(j.batch_id) ?? []), j]);
    for (const [bid, list] of byBatch) {
      const b = this.getBatchRow(workspaceId, bid);
      if (b.budget_limit !== null && total !== null) {
        const committed = this.committedCost(bid);
        const extra = list.reduce((s, j) => s + (j.estimated_cost ?? 0), 0);
        if (committed + extra > b.budget_limit) throw new AppError("BUDGET_EXCEEDED", `Tạo lại sẽ vượt ngân sách batch "${b.name}" (${round4(committed + extra)} > ${b.budget_limit}).`, 409);
      }
    }
    const now = nowIso();
    this.db.tx(() => {
      for (const j of target) {
        this.db.run(
          `UPDATE video_batch_jobs SET status = 'queued', manual_retries = manual_retries + 1, max_attempts = attempt + 3, resubmit_same_key = 0, transient_failures = 0,
             remote_job_id = NULL, next_attempt_at = 0, poll_failures = 0, progress = NULL, error_code = NULL, error_message = NULL, error_detail = NULL, cancel_requested = 0, updated_at = ?
           WHERE id = ? AND status = ?`,
          now,
          j.id,
          j.status,
        );
        recordEvent(this.db, { workspaceId, type: "job.status", batchId: j.batch_id, jobId: j.id, from: j.status, to: "queued", message: "Tạo lại theo yêu cầu" });
      }
      for (const bid of byBatch.keys()) {
        this.db.run("UPDATE video_batches SET status = CASE WHEN status IN ('completed','cancelled') THEN 'running' ELSE status END, updated_at = ? WHERE id = ?", now, bid);
      }
      audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "job.retry", targetType: "jobs", targetId: target.map((j) => j.id).join(","), data: { count: target.length, estimate: total } });
    });
    return { retried: target.map((j) => j.id), estimate: total, skipped };
  }

  /**
   * Tạo PHIÊN BẢN MỚI (V2, V3...) từ một job - prompt có thể sửa. Bản cũ giữ
   * nguyên (không ghi đè asset). Job mới chờ duyệt, trừ khi confirm kèm chi phí.
   */
  regenerate(workspaceId: string, actor: Actor, jobId: string, args: { prompt?: string; negative?: string | null; durationSec?: number; aspectRatio?: string; confirm?: boolean; approvedMaxCost?: number | null; acknowledgeUnknownCost?: boolean }): JobRow {
    const src = this.getJobRow(workspaceId, jobId);
    const batch = this.getBatchRow(workspaceId, src.batch_id);
    const cfg = safeJsonParse<BatchConfig>(src.config_json, defaultBatchConfig());
    const newCfg: BatchConfig = { ...cfg, durationSec: args.durationSec ?? cfg.durationSec, aspectRatio: args.aspectRatio ?? cfg.aspectRatio };
    const prompt = (args.prompt ?? src.prompt).trim();
    const negative = args.negative === undefined ? src.negative : args.negative;
    const refs = safeJsonParse<string[]>(src.reference_asset_ids_json, []);
    const { config, adapter } = this.ctx.providers.resolveById(workspaceId, src.provider_config_id);
    const input = this.buildInput(workspaceId, src.model_id, newCfg, { prompt, negative, referenceAssetIds: refs });
    const issues = adapter.validateInput(input, config);
    if (issues.length) throw new AppError("INPUT_INVALID", issues.map((i) => i.message).join(" "), 422, issues);
    const est = adapter.estimateCost(input, config);
    let startNow = false;
    if (args.confirm) {
      if (est.amount === null && !args.acknowledgeUnknownCost) throw new AppError("COST_UNKNOWN_ACK_REQUIRED", "Không ước tính được chi phí - cần xác nhận chấp nhận chi phí không xác định.", 409);
      if (est.amount !== null && est.amount > 0 && !(Number(args.approvedMaxCost) >= est.amount)) throw new AppError("COST_CONFIRMATION_MISMATCH", `Chi phí ước tính ${est.amount} - xác nhận với mức tối đa ≥ con số này.`, 409);
      if (batch.budget_limit !== null && est.amount !== null && this.committedCost(batch.id) + est.amount > batch.budget_limit) throw new AppError("BUDGET_EXCEEDED", "Tạo phiên bản mới sẽ vượt ngân sách batch.", 409);
      startNow = true;
    }
    const id = newId("job");
    const now = nowIso();
    this.db.tx(() => {
      const maxV = Number(this.db.get<{ v: number }>("SELECT MAX(version) AS v FROM video_batch_jobs WHERE lineage_id = ?", src.lineage_id)?.v ?? 1);
      const maxSeq = Number(this.db.get<{ s: number }>("SELECT MAX(seq) AS s FROM video_batch_jobs WHERE batch_id = ?", src.batch_id)?.s ?? 0);
      this.db.run(
        `INSERT INTO video_batch_jobs (id, batch_id, workspace_id, session_id, seq, prompt_item_id, title, prompt, negative, reference_asset_ids_json,
           provider_config_id, model_id, config_json, status, max_attempts, estimated_cost, lineage_id, version, parent_job_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        src.batch_id,
        workspaceId,
        src.session_id,
        maxSeq + 1,
        src.prompt_item_id,
        src.title,
        prompt,
        negative,
        src.reference_asset_ids_json,
        src.provider_config_id,
        src.model_id,
        JSON.stringify(newCfg),
        startNow ? "queued" : "awaiting_approval",
        newCfg.maxAttempts,
        est.amount,
        src.lineage_id,
        maxV + 1,
        src.id,
        now,
        now,
      );
      if (startNow) this.db.run("UPDATE video_batches SET status = CASE WHEN status IN ('completed','cancelled') THEN 'running' ELSE status END, updated_at = ? WHERE id = ?", now, src.batch_id);
      recordEvent(this.db, { workspaceId, type: "job.created", batchId: src.batch_id, jobId: id, to: startNow ? "queued" : "awaiting_approval", message: `Phiên bản V${maxV + 1} từ ${src.id}` });
      audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "job.regenerate", targetType: "job", targetId: id, data: { from: src.id, version: maxV + 1, promptChanged: prompt !== src.prompt, estimate: est.amount } });
    });
    return this.getJobRow(workspaceId, id);
  }

  /** Duyệt các job lẻ đang chờ duyệt (vd phiên bản mới) */
  approveJobs(workspaceId: string, actor: Actor, jobIds: string[], opts: { confirm: boolean; approvedMaxCost?: number | null; acknowledgeUnknownCost?: boolean }): number {
    if (!opts.confirm) throw new AppError("CONFIRMATION_REQUIRED", "Cần xác nhận (confirm=true).", 409);
    const jobs = jobIds.map((id) => this.getJobRow(workspaceId, id)).filter((j) => j.status === "awaiting_approval");
    const total = jobs.reduce<number | null>((s, j) => (s === null || j.estimated_cost === null ? null : s + j.estimated_cost), 0);
    if (total === null && !opts.acknowledgeUnknownCost) throw new AppError("COST_UNKNOWN_ACK_REQUIRED", "Chi phí không xác định - cần xác nhận.", 409);
    if (total !== null && total > 0 && !(Number(opts.approvedMaxCost) >= total)) throw new AppError("COST_CONFIRMATION_MISMATCH", `Ước tính ${round4(total)} - xác nhận mức tối đa ≥ con số này.`, 409);
    const now = nowIso();
    let n = 0;
    this.db.tx(() => {
      for (const j of jobs) {
        const b = this.getBatchRow(workspaceId, j.batch_id);
        if (b.status === "awaiting_approval") throw new AppError("BATCH_NOT_APPROVED", "Batch chưa được duyệt - duyệt cả batch.", 409);
        if (b.budget_limit !== null && j.estimated_cost !== null && this.committedCost(b.id) + j.estimated_cost > b.budget_limit) throw new AppError("BUDGET_EXCEEDED", "Vượt ngân sách batch.", 409);
        n += this.db.run("UPDATE video_batch_jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'awaiting_approval'", now, j.id).changes;
        this.db.run("UPDATE video_batches SET status = CASE WHEN status IN ('completed','cancelled') THEN 'running' ELSE status END, updated_at = ? WHERE id = ?", now, j.batch_id);
        recordEvent(this.db, { workspaceId, type: "job.status", batchId: j.batch_id, jobId: j.id, from: "awaiting_approval", to: "queued" });
      }
      audit(this.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "job.approve", targetType: "jobs", targetId: jobIds.join(","), data: { estimate: total } });
    });
    return n;
  }

  // ---------------------------------------------------------------- tiện ích trạng thái

  /** Chi phí đã cam kết: thực tế (nếu có) hoặc ước tính của job đã gửi/đang chạy/xong */
  committedCost(batchId: string): number {
    const r = this.db.get<{ c: number }>(
      `SELECT COALESCE(SUM(COALESCE(actual_cost, estimated_cost, 0)), 0) AS c FROM video_batch_jobs
       WHERE batch_id = ? AND (status IN ('submitting','processing','completed') OR (status = 'failed' AND remote_job_id IS NOT NULL))`,
      batchId,
    );
    return Number(r?.c ?? 0);
  }

  /**
   * Đổi trạng thái job có điều kiện (chỉ khi đang ở một trong `from`) + ghi sự kiện.
   * Trả về false nếu job đã bị tiến trình khác đổi trước (chống race).
   */
  transition(j: JobRow, to: JobStatus, fields: Record<string, string | number | null> = {}, from?: JobStatus[]): boolean {
    const allowed = from ?? [j.status];
    const cols = Object.keys(fields);
    const now = nowIso();
    const extra = to === "completed" || to === "failed" || to === "cancelled" ? ", lease_owner = NULL, lease_until = NULL" : "";
    const completedAt = to === "completed" ? ", completed_at = ?" : "";
    const params: (string | number | null)[] = [to, ...cols.map((c) => fields[c] ?? null), now];
    if (completedAt) params.push(now);
    params.push(j.id, ...allowed);
    const r = this.db.run(
      `UPDATE video_batch_jobs SET status = ?${cols.map((c) => `, ${c} = ?`).join("")}, updated_at = ?${completedAt}${extra} WHERE id = ? AND status IN (${allowed.map(() => "?").join(",")})`,
      ...params,
    );
    if (r.changes) {
      recordEvent(this.db, { workspaceId: j.workspace_id, type: "job.status", batchId: j.batch_id, jobId: j.id, from: j.status, to, message: (fields.error_message as string) ?? null });
      this.refreshBatch(j.batch_id);
    }
    return r.changes > 0;
  }

  /** Batch đang chạy/tạm dừng mà mọi job đã xong → completed; cộng chi phí thực tế */
  refreshBatch(batchId: string): void {
    const b = this.db.get<BatchRow>("SELECT * FROM video_batches WHERE id = ?", batchId);
    if (!b) return;
    const counts = this.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM video_batch_jobs WHERE batch_id = ? GROUP BY status", batchId);
    const total = counts.reduce((s, c) => s + Number(c.n), 0);
    const terminal = counts.filter((c) => TERMINAL_JOB_STATUSES.includes(c.status as JobStatus)).reduce((s, c) => s + Number(c.n), 0);
    const actual = this.db.get<{ c: number | null; n: number }>("SELECT SUM(actual_cost) AS c, COUNT(actual_cost) AS n FROM video_batch_jobs WHERE batch_id = ?", batchId);
    const actualCost = actual && Number(actual.n) > 0 ? round4(Number(actual.c ?? 0)) : null;
    let status = b.status;
    // Batch chờ duyệt mà mọi job đã bị hủy cũng phải khép lại (không để "chờ duyệt" với 0 job)
    if ((b.status === "running" || b.status === "paused" || b.status === "awaiting_approval") && total > 0 && terminal === total) {
      const cancelledAll = counts.every((c) => c.status === "cancelled");
      status = cancelledAll ? "cancelled" : "completed";
    }
    if (status !== b.status || actualCost !== b.actual_cost) {
      this.db.run("UPDATE video_batches SET status = ?, actual_cost = ?, updated_at = ? WHERE id = ?", status, actualCost, nowIso(), batchId);
      if (status !== b.status) recordEvent(this.db, { workspaceId: b.workspace_id, type: "batch.status", batchId, from: b.status, to: status });
    }
  }

  // ---------------------------------------------------------------- đọc

  assertSession(workspaceId: string, sessionId: string): void {
    if (!this.db.get("SELECT 1 AS x FROM studio_sessions WHERE id = ? AND workspace_id = ?", sessionId, workspaceId)) throw new AppError("NOT_FOUND", "Không tìm thấy phiên làm việc.", 404);
  }

  getBatchRow(workspaceId: string, id: string): BatchRow {
    const r = this.db.get<BatchRow>("SELECT * FROM video_batches WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!r) throw new AppError("NOT_FOUND", "Không tìm thấy batch.", 404);
    return r;
  }

  getJobRow(workspaceId: string, id: string): JobRow {
    const r = this.db.get<JobRow>("SELECT * FROM video_batch_jobs WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!r) throw new AppError("NOT_FOUND", "Không tìm thấy job.", 404);
    return r;
  }

  batchToPublic(b: BatchRow) {
    const counts = Object.fromEntries(
      this.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM video_batch_jobs WHERE batch_id = ? GROUP BY status", b.id).map((c) => [c.status, Number(c.n)]),
    ) as Record<string, number>;
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    const done = (counts.completed ?? 0) + (counts.failed ?? 0) + (counts.cancelled ?? 0);
    const provider = this.ctx.providers.rowById(b.provider_config_id);
    return {
      id: b.id,
      sessionId: b.session_id,
      name: b.name,
      mode: b.mode,
      promptSetId: b.prompt_set_id,
      providerConfigId: b.provider_config_id,
      providerName: provider?.name ?? null,
      providerType: provider?.provider_type ?? null,
      modelId: b.model_id,
      config: safeJsonParse<BatchConfig>(b.config_json, defaultBatchConfig()),
      maxConcurrency: b.max_concurrency,
      status: b.status,
      budgetLimit: b.budget_limit,
      estimate: safeJsonParse(b.estimate_json, null),
      estimatedCost: b.estimated_cost,
      actualCost: b.actual_cost,
      committedCost: round4(this.committedCost(b.id)),
      currency: b.currency,
      approvedAt: b.approved_at,
      counts,
      total,
      progress: total ? Math.round((done / total) * 100) : 0,
      shopeeUrl: b.shopee_url ?? null,
      fbPage: b.fb_page_id === "none" ? ("none" as const) : b.fb_page_id ? { id: b.fb_page_id, name: pageName(this.ctx, b.fb_page_id) ?? "(Page đã xoá)" } : null,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    };
  }

  jobToPublic(j: JobRow) {
    const asset = j.output_asset_id ? this.db.get<{ id: string; thumbnail_path: string | null; duration_sec: number | null }>("SELECT id, thumbnail_path, duration_sec FROM video_assets WHERE id = ?", j.output_asset_id) : undefined;
    const provider = this.ctx.providers.rowById(j.provider_config_id);
    return {
      id: j.id,
      batchId: j.batch_id,
      sessionId: j.session_id,
      seq: j.seq,
      title: j.title,
      prompt: j.prompt,
      negative: j.negative,
      referenceAssetIds: safeJsonParse<string[]>(j.reference_asset_ids_json, []),
      providerConfigId: j.provider_config_id,
      providerName: provider?.name ?? null,
      modelId: j.model_id,
      config: safeJsonParse<BatchConfig>(j.config_json, defaultBatchConfig()),
      status: j.status,
      attempt: j.attempt,
      maxAttempts: j.max_attempts,
      remoteJobId: j.remote_job_id,
      progress: j.progress,
      cancelRequested: Boolean(j.cancel_requested),
      error: j.error_code || j.error_message ? { code: j.error_code, message: j.error_message, detail: j.error_detail } : null,
      nextAttemptAt: j.status === "queued" && j.next_attempt_at > Date.now() ? new Date(j.next_attempt_at).toISOString() : null,
      outputAssetId: j.output_asset_id,
      output: asset
        ? { assetId: asset.id, thumbnail: asset.thumbnail_path ? `/api/assets/${asset.id}/thumbnail` : null, preview: `/api/assets/${asset.id}/preview`, download: `/api/assets/${asset.id}/file?download=1`, durationSec: asset.duration_sec }
        : null,
      estimatedCost: j.estimated_cost,
      actualCost: j.actual_cost,
      lineageId: j.lineage_id,
      version: j.version,
      parentJobId: j.parent_job_id,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
      submittedAt: j.submitted_at,
      completedAt: j.completed_at,
    };
  }

  listBatches(workspaceId: string, opts: { sessionId?: string | null; limit?: number } = {}) {
    const rows = opts.sessionId
      ? this.db.all<BatchRow>("SELECT * FROM video_batches WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT ?", workspaceId, opts.sessionId, opts.limit ?? 100)
      : this.db.all<BatchRow>("SELECT * FROM video_batches WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?", workspaceId, opts.limit ?? 100);
    return rows.map((b) => this.batchToPublic(b));
  }

  listJobs(workspaceId: string, f: { batchId?: string; sessionId?: string; statuses?: string[]; q?: string; limit?: number; offset?: number }) {
    const where = ["workspace_id = ?"];
    const params: (string | number)[] = [workspaceId];
    if (f.batchId) {
      where.push("batch_id = ?");
      params.push(f.batchId);
    }
    if (f.sessionId) {
      where.push("session_id = ?");
      params.push(f.sessionId);
    }
    if (f.statuses?.length) {
      where.push(`status IN (${f.statuses.map(() => "?").join(",")})`);
      params.push(...f.statuses);
    }
    if (f.q?.trim()) {
      where.push("(prompt LIKE ? OR title LIKE ? OR id LIKE ?)");
      const like = `%${f.q.trim()}%`;
      params.push(like, like, like);
    }
    const total = Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM video_batch_jobs WHERE ${where.join(" AND ")}`, ...params)?.n ?? 0);
    const rows = this.db.all<JobRow>(`SELECT * FROM video_batch_jobs WHERE ${where.join(" AND ")} ORDER BY created_at DESC, seq ASC LIMIT ? OFFSET ?`, ...params, Math.min(500, f.limit ?? 200), f.offset ?? 0);
    return { total, jobs: rows.map((j) => this.jobToPublic(j)) };
  }

  versions(workspaceId: string, jobId: string) {
    const j = this.getJobRow(workspaceId, jobId);
    return this.db.all<JobRow>("SELECT * FROM video_batch_jobs WHERE lineage_id = ? AND workspace_id = ? ORDER BY version", j.lineage_id, workspaceId).map((x) => this.jobToPublic(x));
  }

  events(workspaceId: string, opts: { batchId?: string; jobId?: string; afterId?: number; limit?: number }) {
    const where = ["workspace_id = ?"];
    const params: (string | number)[] = [workspaceId];
    if (opts.batchId) {
      where.push("batch_id = ?");
      params.push(opts.batchId);
    }
    if (opts.jobId) {
      where.push("job_id = ?");
      params.push(opts.jobId);
    }
    if (opts.afterId) {
      where.push("id > ?");
      params.push(opts.afterId);
    }
    const rows = this.db.all<EventRow>(`SELECT * FROM job_events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...params, opts.limit ?? 200);
    return rows.map(eventToPublic);
  }
}
