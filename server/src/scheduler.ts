import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AppContext } from "./context.ts";
import { BatchService, defaultBatchConfig, type BatchConfig, type BatchRow, type JobRow } from "./batches.ts";
import { recordEvent } from "./events.ts";
import { ERROR_MESSAGES, ProviderError, type ErrorCategory, type ProviderCallContext, type ResolvedProviderConfig, type VideoProvider } from "./providers/types.ts";
import type { ProviderConfigRow } from "./providers/registry.ts";
import { newId, nowIso, redact, safeJsonParse } from "./util.ts";
import { enqueueReel } from "./fbreels/queue.ts";

/**
 * BATCH SCHEDULER - hàng đợi bền trên SQLite.
 *
 * - Nhận job bằng giao dịch BEGIN IMMEDIATE + UPDATE có điều kiện trạng thái +
 *   lease (worker id + hạn) → nhiều worker/tiến trình không bao giờ nhận trùng.
 * - Giới hạn đồng thời = min(số luồng của batch, giới hạn của cấu hình provider),
 *   đếm job submitting/processing thật trong DB (không đếm trong bộ nhớ).
 * - Rate limiter cửa sổ 1 phút lưu DB (provider_rate_windows) - chung mọi worker.
 * - Thử lại lỗi tạm thời có exponential backoff + jitter, trần max_attempts.
 * - Idempotency key = <jobId>#<attempt>. Gửi lỗi mà KHÔNG chứng minh được provider
 *   chưa nhận: provider có idempotency → gửi lại đúng key cũ; không có → dừng ở
 *   failed/SUBMISSION_UNKNOWN, không tự gửi lại (tránh tạo trùng + tính phí 2 lần).
 * - Restart: mọi trạng thái nằm trong DB; lease hết hạn được thu hồi.
 * - Một (job, attempt) chỉ ra một asset (unique index) → poll/webhook trùng vô hại.
 */
export interface SchedulerOptions {
  tickMs?: number;
  leaseMs?: number;
  /** Chu kỳ poll mặc định (ms) - provider có thể ghi đè qua options.pollIntervalMs */
  pollIntervalMs?: number;
  maxPollFailures?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  workerId?: string;
  log?: (line: string) => void;
}

export class Scheduler {
  readonly workerId: string;
  private ctx: AppContext;
  private svc: BatchService;
  private opts: Required<Omit<SchedulerOptions, "workerId" | "log">>;
  private log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private inflight = new Set<Promise<unknown>>();
  /** Số job đang submitting/processing đồng thời lớn nhất quan sát được theo provider (để kiểm thử) */
  readonly observedMaxActive = new Map<string, number>();

  constructor(ctx: AppContext, opts: SchedulerOptions = {}) {
    this.ctx = ctx;
    this.svc = new BatchService(ctx);
    this.workerId = opts.workerId ?? `${os.hostname()}-${process.pid}-${newId("w").slice(-6)}`;
    this.log = opts.log ?? ((l) => console.log(`[scheduler] ${l}`));
    this.opts = {
      tickMs: opts.tickMs ?? ctx.cfg.tickMs,
      leaseMs: opts.leaseMs ?? 90_000,
      pollIntervalMs: opts.pollIntervalMs ?? 8_000,
      maxPollFailures: opts.maxPollFailures ?? 20,
      backoffBaseMs: opts.backoffBaseMs ?? 2_000,
      backoffMaxMs: opts.backoffMaxMs ?? 5 * 60_000,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      await this.tick().catch((e) => this.log(`tick lỗi: ${redact((e as Error).message)}`));
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.tickMs);
    };
    this.timer = setTimeout(loop, 10);
  }

  /** Dừng nhận việc mới; chờ thao tác đang dở (gửi/poll/tải) xong */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.inflight]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p)).catch(() => {});
    return p;
  }

  /** Một vòng: thu hồi lease hết hạn → gửi job mới → poll job đang chạy */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.reclaimExpiredLeases();
      this.settleIdleBatches();
      const submits = this.claimForSubmit().map((c) => this.track(this.submit(c.job, c.provider)));
      const polls = this.claimForPoll().map((c) => this.track(this.poll(c.job, c.provider)));
      await Promise.allSettled([...submits, ...polls]);
    } finally {
      this.running = false;
    }
  }

  // ---------------------------------------------------------------- tiện ích

  private providerCtx(config: ResolvedProviderConfig, job: JobRow): ProviderCallContext {
    return {
      config,
      idempotencyKey: job.idempotency_key ?? `${job.id}#${job.attempt}`,
      workDir: this.ctx.storage.tmpDir("provider", config.id),
      log: (l) => this.log(`[${job.id}] ${redact(l, [config.apiKey])}`),
    };
  }

  private resolveProvider(row: ProviderConfigRow): { config: ResolvedProviderConfig; adapter: VideoProvider } {
    return { config: this.ctx.providers.resolve(row), adapter: this.ctx.providers.adapter(row.provider_type) };
  }

  backoffMs(attempt: number, retryAfterSec: number | null): number {
    const exp = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
    const jitter = exp * (0.8 + Math.random() * 0.4);
    return Math.max(retryAfterSec ? retryAfterSec * 1000 : 0, Math.round(jitter));
  }

  private pollInterval(config: ResolvedProviderConfig): number {
    const v = Number(config.options?.pollIntervalMs);
    return Number.isFinite(v) && v >= 200 ? v : this.opts.pollIntervalMs;
  }

  /** Lấy một suất trong cửa sổ rate-limit 1 phút của provider (trong giao dịch đang mở) */
  private takeRateToken(providerId: string, rpm: number, now: number): boolean {
    const win = Math.floor(now / 60_000);
    this.ctx.db.run("DELETE FROM provider_rate_windows WHERE provider_config_id = ? AND window_start < ?", providerId, win - 1);
    const cur = Number(this.ctx.db.get<{ count: number }>("SELECT count FROM provider_rate_windows WHERE provider_config_id = ? AND window_start = ?", providerId, win)?.count ?? 0);
    if (cur >= rpm) return false;
    this.ctx.db.run(
      `INSERT INTO provider_rate_windows (provider_config_id, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(provider_config_id, window_start) DO UPDATE SET count = count + 1`,
      providerId,
      win,
    );
    return true;
  }

  private event(job: JobRow, type: string, message: string, data?: unknown): void {
    recordEvent(this.ctx.db, { workspaceId: job.workspace_id, type, batchId: job.batch_id, jobId: job.id, message, data });
  }

  // ---------------------------------------------------------------- thu hồi lease

  /** Batch đang mở nhưng không còn job nào chưa xong (vd. dữ liệu cũ, hủy lẻ) → khép trạng thái đúng */
  settleIdleBatches(): void {
    const idle = this.ctx.db.all<{ id: string }>(
      `SELECT b.id FROM video_batches b WHERE b.status IN ('running','paused','awaiting_approval')
         AND EXISTS (SELECT 1 FROM video_batch_jobs j WHERE j.batch_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM video_batch_jobs j WHERE j.batch_id = b.id AND j.status NOT IN ('completed','failed','cancelled'))
       LIMIT 50`,
    );
    for (const b of idle) this.svc.refreshBatch(b.id);
  }

  reclaimExpiredLeases(): void {
    const now = Date.now();
    const db = this.ctx.db;
    const expired = db.all<JobRow>("SELECT * FROM video_batch_jobs WHERE status IN ('submitting','processing') AND lease_until IS NOT NULL AND lease_until < ?", now);
    for (const j of expired) {
      db.tx(() => {
        const fresh = db.get<JobRow>("SELECT * FROM video_batch_jobs WHERE id = ?", j.id);
        if (!fresh || fresh.lease_until === null || fresh.lease_until >= now || !["submitting", "processing"].includes(fresh.status)) return;
        if (fresh.status === "processing") {
          db.run("UPDATE video_batch_jobs SET lease_owner = NULL, lease_until = NULL, next_poll_at = 0, updated_at = ? WHERE id = ?", nowIso(), fresh.id);
          this.event(fresh, "job.lease_reclaimed", "Worker cũ mất - tiếp tục theo dõi job ở provider.");
          return;
        }
        // submitting: worker chết giữa lúc gửi → không biết provider đã nhận chưa
        const row = this.ctx.providers.rowById(fresh.provider_config_id);
        const caps = row ? this.ctx.providers.adapter(row.provider_type).getCapabilities(null) : null;
        if (caps?.idempotency) {
          db.run(
            "UPDATE video_batch_jobs SET status = 'queued', resubmit_same_key = 1, lease_owner = NULL, lease_until = NULL, next_attempt_at = 0, updated_at = ? WHERE id = ?",
            nowIso(),
            fresh.id,
          );
          recordEvent(db, { workspaceId: fresh.workspace_id, type: "job.status", batchId: fresh.batch_id, jobId: fresh.id, from: "submitting", to: "queued", message: "Gửi bị ngắt - gửi lại với đúng idempotency key cũ (provider không tạo trùng)." });
        } else {
          this.svc.transition(fresh, "failed", { error_code: "SUBMISSION_UNKNOWN", error_message: ERROR_MESSAGES.SUBMISSION_UNKNOWN }, ["submitting"]);
        }
      });
    }
  }

  // ---------------------------------------------------------------- gửi

  claimForSubmit(): { job: JobRow; provider: ProviderConfigRow }[] {
    const db = this.ctx.db;
    const now = Date.now();
    return db.tx(() => {
      const candidates = db.all<JobRow & { b_status: string; b_max: number; b_budget: number | null; b_approved_max: number | null }>(
        `SELECT j.*, b.status AS b_status, b.max_concurrency AS b_max, b.budget_limit AS b_budget, b.approved_max_cost AS b_approved_max
         FROM video_batch_jobs j JOIN video_batches b ON b.id = j.batch_id
         WHERE j.status IN ('queued','waiting_for_capacity') AND b.status = 'running' AND j.next_attempt_at <= ?
         ORDER BY b.created_at, j.seq LIMIT 500`,
        now,
      );
      if (!candidates.length) return [];
      const activeByProvider = new Map<string, number>();
      for (const r of db.all<{ p: string; n: number }>("SELECT provider_config_id AS p, COUNT(*) AS n FROM video_batch_jobs WHERE status IN ('submitting','processing') GROUP BY provider_config_id"))
        activeByProvider.set(r.p, Number(r.n));
      const activeByBatch = new Map<string, number>();
      for (const r of db.all<{ b: string; n: number }>("SELECT batch_id AS b, COUNT(*) AS n FROM video_batch_jobs WHERE status IN ('submitting','processing') GROUP BY batch_id"))
        activeByBatch.set(r.b, Number(r.n));
      const providers = new Map<string, ProviderConfigRow | undefined>();
      const committed = new Map<string, number>();
      const claimed: { job: JobRow; provider: ProviderConfigRow }[] = [];

      for (const c of candidates) {
        if (!providers.has(c.provider_config_id)) providers.set(c.provider_config_id, this.ctx.providers.rowById(c.provider_config_id));
        const prov = providers.get(c.provider_config_id);
        if (!prov || !prov.enabled) {
          this.markWaiting(c, "Provider đang tắt - job chờ.");
          continue;
        }
        const pActive = activeByProvider.get(prov.id) ?? 0;
        const bActive = activeByBatch.get(c.batch_id) ?? 0;
        if (pActive >= prov.max_concurrency || bActive >= c.b_max) {
          this.markWaiting(c, pActive >= prov.max_concurrency ? `Chờ slot provider (${pActive}/${prov.max_concurrency} đang chạy).` : `Chờ slot batch (${bActive}/${c.b_max} luồng).`);
          continue;
        }
        // Ngân sách: đã cam kết + job này ≤ ngân sách / mức đã duyệt
        const limit = c.b_budget ?? null;
        if (limit !== null && c.estimated_cost !== null) {
          if (!committed.has(c.batch_id)) committed.set(c.batch_id, this.svc.committedCost(c.batch_id));
          const after = (committed.get(c.batch_id) ?? 0) + c.estimated_cost;
          if (after > limit + 1e-9) {
            db.run("UPDATE video_batches SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'running'", nowIso(), c.batch_id);
            recordEvent(db, { workspaceId: c.workspace_id, type: "batch.paused", batchId: c.batch_id, from: "running", to: "paused", message: `Tự tạm dừng: job tiếp theo sẽ vượt ngân sách (${after} > ${limit}).` });
            continue;
          }
          committed.set(c.batch_id, after);
        }
        if (!this.takeRateToken(prov.id, prov.requests_per_minute, now)) {
          this.markWaiting(c, `Chờ giới hạn tần suất (${prov.requests_per_minute} yêu cầu/phút).`);
          continue;
        }
        const reuse = c.resubmit_same_key === 1 && c.idempotency_key;
        const attempt = reuse ? c.attempt : c.attempt + 1;
        const key = reuse ? c.idempotency_key! : `${c.id}#${attempt}`;
        const r = db.run(
          `UPDATE video_batch_jobs SET status = 'submitting', attempt = ?, idempotency_key = ?, resubmit_same_key = 0, lease_owner = ?, lease_until = ?, updated_at = ?
           WHERE id = ? AND status IN ('queued','waiting_for_capacity')`,
          attempt,
          key,
          this.workerId,
          now + this.opts.leaseMs,
          nowIso(),
          c.id,
        );
        if (!r.changes) continue;
        activeByProvider.set(prov.id, pActive + 1);
        activeByBatch.set(c.batch_id, bActive + 1);
        this.observedMaxActive.set(prov.id, Math.max(this.observedMaxActive.get(prov.id) ?? 0, pActive + 1));
        recordEvent(db, { workspaceId: c.workspace_id, type: "job.status", batchId: c.batch_id, jobId: c.id, from: c.status, to: "submitting", message: `Lần thử ${attempt}${reuse ? " (gửi lại cùng idempotency key)" : ""}` });
        const fresh = db.get<JobRow>("SELECT * FROM video_batch_jobs WHERE id = ?", c.id)!;
        claimed.push({ job: fresh, provider: prov });
      }
      return claimed;
    });
  }

  private markWaiting(j: JobRow, reason: string): void {
    if (j.status === "waiting_for_capacity") return;
    const r = this.ctx.db.run("UPDATE video_batch_jobs SET status = 'waiting_for_capacity', error_message = NULL, updated_at = ? WHERE id = ? AND status = 'queued'", nowIso(), j.id);
    if (r.changes) recordEvent(this.ctx.db, { workspaceId: j.workspace_id, type: "job.status", batchId: j.batch_id, jobId: j.id, from: "queued", to: "waiting_for_capacity", message: reason });
  }

  private async submit(job: JobRow, provRow: ProviderConfigRow): Promise<void> {
    const db = this.ctx.db;
    const { config, adapter } = this.resolveProvider(provRow);
    const cfg = safeJsonParse<BatchConfig>(job.config_json, defaultBatchConfig());
    const pctx = this.providerCtx(config, job);
    let remoteJobId: string;
    try {
      const input = this.svc.buildInput(job.workspace_id, job.model_id, cfg, { prompt: job.prompt, negative: job.negative, referenceAssetIds: safeJsonParse(job.reference_asset_ids_json, []) });
      const issues = adapter.validateInput(input, config);
      if (issues.length) throw new ProviderError("INVALID_INPUT", issues.map((i) => i.message).join(" "), { provenNotSubmitted: true, transient: false });
      ({ remoteJobId } = await adapter.submitGeneration(input, pctx));
    } catch (e) {
      this.handleSubmitError(job, adapter, config, e);
      return;
    }
    const pollAt = Date.now() + Math.min(this.pollInterval(config), 3000);
    const r = db.run(
      `UPDATE video_batch_jobs SET status = 'processing', remote_job_id = ?, submitted_at = ?, lease_owner = NULL, lease_until = NULL, next_poll_at = ?,
         transient_failures = 0, error_code = NULL, error_message = NULL, error_detail = NULL, progress = 0, updated_at = ?
       WHERE id = ? AND status = 'submitting' AND lease_owner = ?`,
      remoteJobId,
      nowIso(),
      pollAt,
      nowIso(),
      job.id,
      this.workerId,
    );
    if (!r.changes) {
      this.log(`[${job.id}] mất lease trong lúc gửi - task ${remoteJobId} vẫn được ghi để không mất dấu`);
      db.run("UPDATE video_batch_jobs SET remote_job_id = COALESCE(remote_job_id, ?), updated_at = ? WHERE id = ?", remoteJobId, nowIso(), job.id);
      return;
    }
    recordEvent(db, { workspaceId: job.workspace_id, type: "job.status", batchId: job.batch_id, jobId: job.id, from: "submitting", to: "processing", message: `Provider đã nhận (remote ${remoteJobId})` });
    const fresh = db.get<JobRow>("SELECT * FROM video_batch_jobs WHERE id = ?", job.id)!;
    if (fresh.cancel_requested) await this.tryCancelRemote(fresh, adapter, config);
  }

  private handleSubmitError(job: JobRow, adapter: VideoProvider, config: ResolvedProviderConfig, e: unknown): void {
    const pe = e instanceof ProviderError ? e : new ProviderError("UNKNOWN", (e as Error)?.message ?? String(e));
    const detail = redact(pe.message, [config.apiKey]);
    const caps = adapter.getCapabilities(config);
    const now = Date.now();
    if (pe.provenNotSubmitted) {
      if (pe.transient && job.attempt < job.max_attempts) {
        const delay = this.backoffMs(job.attempt, pe.retryAfterSec);
        this.svc.transition(job, "queued", { next_attempt_at: now + delay, error_code: pe.category, error_message: `${ERROR_MESSAGES[pe.category]} Thử lại sau ${Math.round(delay / 1000)}s (lần ${job.attempt}/${job.max_attempts}).`, error_detail: detail, lease_owner: null, lease_until: null }, ["submitting"]);
        return;
      }
      this.svc.transition(job, "failed", { error_code: pe.category, error_message: ERROR_MESSAGES[pe.category] + (pe.transient ? ` Đã thử ${job.attempt} lần.` : ""), error_detail: detail }, ["submitting"]);
      return;
    }
    // Không chứng minh được provider chưa nhận
    if (caps.idempotency && job.transient_failures < 5) {
      const delay = this.backoffMs(job.transient_failures + 1, pe.retryAfterSec);
      this.svc.transition(
        job,
        "queued",
        {
          resubmit_same_key: 1,
          transient_failures: job.transient_failures + 1,
          next_attempt_at: now + delay,
          error_code: pe.category,
          error_message: `${ERROR_MESSAGES[pe.category]} Không rõ provider đã nhận chưa → gửi lại với đúng idempotency key cũ sau ${Math.round(delay / 1000)}s.`,
          error_detail: detail,
          lease_owner: null,
          lease_until: null,
        },
        ["submitting"],
      );
      return;
    }
    this.svc.transition(job, "failed", { error_code: "SUBMISSION_UNKNOWN", error_message: ERROR_MESSAGES.SUBMISSION_UNKNOWN, error_detail: detail }, ["submitting"]);
  }

  private async tryCancelRemote(job: JobRow, adapter: VideoProvider, config: ResolvedProviderConfig): Promise<void> {
    if (!adapter.cancelGeneration || !job.remote_job_id) return;
    try {
      await adapter.cancelGeneration(job.remote_job_id, this.providerCtx(config, job));
      this.svc.transition(job, "cancelled", { error_message: "Đã hủy ở provider theo yêu cầu." }, ["processing"]);
    } catch (e) {
      this.event(job, "job.cancel_failed", `Provider không hủy được: ${redact((e as Error).message, [config.apiKey])} - job tiếp tục chạy.`);
      this.ctx.db.run("UPDATE video_batch_jobs SET cancel_requested = 0 WHERE id = ?", job.id);
    }
  }

  // ---------------------------------------------------------------- poll

  claimForPoll(): { job: JobRow; provider: ProviderConfigRow }[] {
    const db = this.ctx.db;
    const now = Date.now();
    return db.tx(() => {
      const rows = db.all<JobRow>(
        "SELECT * FROM video_batch_jobs WHERE status = 'processing' AND next_poll_at <= ? AND (lease_until IS NULL OR lease_until < ?) ORDER BY next_poll_at LIMIT 50",
        now,
        now,
      );
      const out: { job: JobRow; provider: ProviderConfigRow }[] = [];
      for (const j of rows) {
        const prov = this.ctx.providers.rowById(j.provider_config_id);
        if (!prov) continue;
        const r = db.run(
          "UPDATE video_batch_jobs SET lease_owner = ?, lease_until = ? WHERE id = ? AND status = 'processing' AND (lease_until IS NULL OR lease_until < ?)",
          this.workerId,
          now + this.opts.leaseMs,
          j.id,
          now,
        );
        if (r.changes) out.push({ job: { ...j, lease_owner: this.workerId }, provider: prov });
      }
      return out;
    });
  }

  private releasePoll(job: JobRow, nextPollAt: number, extra: Record<string, string | number | null> = {}): void {
    const cols = Object.keys(extra);
    this.ctx.db.run(
      `UPDATE video_batch_jobs SET lease_owner = NULL, lease_until = NULL, next_poll_at = ?${cols.map((c) => `, ${c} = ?`).join("")}, updated_at = ? WHERE id = ? AND lease_owner = ?`,
      nextPollAt,
      ...cols.map((c) => extra[c] ?? null),
      nowIso(),
      job.id,
      this.workerId,
    );
  }

  private async poll(job: JobRow, provRow: ProviderConfigRow): Promise<void> {
    const { config, adapter } = this.resolveProvider(provRow);
    const interval = this.pollInterval(config);
    let st;
    try {
      st = await adapter.getGenerationStatus(job.remote_job_id!, this.providerCtx(config, job));
    } catch (e) {
      const failures = job.poll_failures + 1;
      const msg = redact((e as Error).message, [config.apiKey]);
      if (failures >= this.opts.maxPollFailures) {
        this.svc.transition(job, "failed", { error_code: "TRACKING_LOST", error_message: `Không hỏi được trạng thái job ở provider sau ${failures} lần (task ${job.remote_job_id}). Kiểm tra trên trang provider.`, error_detail: msg }, ["processing"]);
        return;
      }
      this.releasePoll(job, Date.now() + this.backoffMs(failures, (e as ProviderError).retryAfterSec ?? null), { poll_failures: failures, error_detail: msg });
      return;
    }

    if (st.status === "queued" || st.status === "processing") {
      this.releasePoll(job, Date.now() + interval, { poll_failures: 0, progress: st.progress ?? null });
      if (job.progress !== (st.progress ?? null) && st.progress !== null) this.event(job, "job.progress", `${st.progress}%`, { progress: st.progress });
      return;
    }
    if (st.status === "cancelled") {
      this.svc.transition(job, "cancelled", { error_message: "Provider báo job đã bị hủy." }, ["processing"]);
      return;
    }
    if (st.status === "failed") {
      const err = st.error ?? { category: "GENERATION_FAILED" as ErrorCategory, message: "Tạo video thất bại.", transient: false };
      const actual = adapter.actualCost?.(st.usage ?? null, { modelId: job.model_id } as never, config) ?? null;
      if (err.transient && job.attempt < job.max_attempts) {
        const delay = this.backoffMs(job.attempt, null);
        this.svc.transition(
          job,
          "queued",
          { remote_job_id: null, next_attempt_at: Date.now() + delay, error_code: err.category, error_message: `${err.message} - lỗi tạm thời, tạo lại sau ${Math.round(delay / 1000)}s (lần ${job.attempt}/${job.max_attempts}).`, error_detail: err.providerCode ?? null, actual_cost: actual, progress: null },
          ["processing"],
        );
        return;
      }
      this.svc.transition(job, "failed", { error_code: err.category, error_message: `${ERROR_MESSAGES[err.category] ?? ""} ${err.message}`.trim(), error_detail: err.providerCode ?? null, actual_cost: actual }, ["processing"]);
      return;
    }
    // completed → tải về kho bền
    await this.finalize(job, adapter, config, st.usage ?? null, interval);
  }

  private async finalize(job: JobRow, adapter: VideoProvider, config: ResolvedProviderConfig, usage: { tokens?: number | null; durationSec?: number | null } | null, interval: number): Promise<void> {
    const db = this.ctx.db;
    let asset = this.ctx.storage.existingForJob(job.id, job.attempt);
    if (!asset) {
      const tmp = path.join(this.ctx.storage.tmpDir("downloads"), `${job.id}-${job.attempt}-${Date.now()}.mp4`);
      try {
        const res = await adapter.retrieveResult(job.remote_job_id!, this.providerCtx(config, job));
        if (res.filePath) fs.copyFileSync(res.filePath, tmp);
        else if (res.url) await this.ctx.storage.downloadToTmp(res.url, tmp, this.ctx.fetchImpl);
        else throw new ProviderError("INVALID_RESULT", "Provider không trả file/URL kết quả.");
        const b = db.get<BatchRow>("SELECT * FROM video_batches WHERE id = ?", job.batch_id);
        asset = await this.ctx.storage.ingestFile({
          workspaceId: job.workspace_id,
          sessionId: job.session_id,
          tmpPath: tmp,
          fileName: `${(b?.name ?? "batch").replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40)}-${String(job.seq).padStart(3, "0")}-v${job.version}.mp4`,
          kind: "generated",
          origin: "provider",
          createdBy: b?.created_by ?? null,
          sourceJobId: job.id,
          sourceAttempt: job.attempt,
          folder: path.join("batches", job.batch_id),
        });
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        const failures = job.poll_failures + 1;
        const msg = redact((e as Error).message, [config.apiKey]);
        const pe = e as ProviderError;
        if (failures >= 5 || (pe.category && pe.category !== "DOWNLOAD_FAILED" && pe.category !== "TIMEOUT" && pe.category !== "PROVIDER_UNAVAILABLE")) {
          this.svc.transition(job, "failed", { error_code: pe.category ?? "DOWNLOAD_FAILED", error_message: `${ERROR_MESSAGES[(pe.category as ErrorCategory) ?? "DOWNLOAD_FAILED"] ?? ""} ${msg}`.trim(), error_detail: msg }, ["processing"]);
        } else {
          this.releasePoll(job, Date.now() + this.backoffMs(failures, null), { poll_failures: failures, error_detail: msg });
        }
        return;
      }
    }
    const actual = adapter.actualCost?.(usage, { modelId: job.model_id } as never, config) ?? null;
    db.tx(() => {
      const ok = this.svc.transition(job, "completed", { output_asset_id: asset!.id, progress: 100, actual_cost: actual, error_code: null, error_message: null, error_detail: null }, ["processing"]);
      if (ok) {
        db.run(
          `INSERT INTO generation_versions (id, workspace_id, lineage_id, version, job_id, asset_id, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(lineage_id, version) DO UPDATE SET asset_id = excluded.asset_id, job_id = excluded.job_id`,
          newId("ver"),
          job.workspace_id,
          job.lineage_id,
          job.version,
          job.id,
          asset!.id,
          job.prompt,
          nowIso(),
        );
        this.svc.refreshBatch(job.batch_id);
      }
    });
    try {
      enqueueReel(this.ctx, asset!.id);
    } catch (e) {
      console.warn(`[fbreels] Không xếp được video vào hàng đăng: ${(e as Error).message}`);
    }
    void interval;
  }

  /** Webhook: chỉ là TÍN HIỆU - đặt job poll ngay, trạng thái thật lấy từ API provider */
  nudge(providerConfigId: string, remoteJobId: string): boolean {
    return this.ctx.db.run("UPDATE video_batch_jobs SET next_poll_at = 0 WHERE provider_config_id = ? AND remote_job_id = ? AND status = 'processing'", providerConfigId, remoteJobId).changes > 0;
  }
}

/** Dùng cho webhook khi scheduler ở tiến trình khác: chỉ cần ghi DB */
export function nudgeJob(ctx: AppContext, providerConfigId: string, remoteJobId: string): boolean {
  return ctx.db.run("UPDATE video_batch_jobs SET next_poll_at = 0 WHERE provider_config_id = ? AND remote_job_id = ? AND status = 'processing'", providerConfigId, remoteJobId).changes > 0;
}
