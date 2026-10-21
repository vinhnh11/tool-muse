import fs from "node:fs";
import type { AppContext } from "../context.ts";
import { nowIso, redact, sleep as realSleep } from "../util.ts";
import { buildCaption } from "./caption.ts";
import { configuredWorkspaces, getLastPublishAt, getPageToken, getReelsConfig, getReelsPause, setLastPublishAt, setReelsPause, type ReelsConfig } from "./config.ts";
import { GraphError, GraphReelsClient, isAuthKind, isTransientKind } from "./graph.ts";
import { sweepMissing, type ReelPostRow } from "./queue.ts";

export interface PublisherOptions {
  tickMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Cho test: chu kỳ polling trạng thái */
  pollEveryMs?: number;
  pollMaxMs?: number;
}

/** Dòng 'publishing' mới hơn ngưỡng này coi như tiến trình khác đang đăng thật, recover() không đụng tới */
export const STALE_PUBLISHING_MS = 15 * 60_000;
/** Thử lại lỗi tạm thời ở bước start/upload: tối đa 3 lần, giãn cách tăng dần */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

const RESTART_MSG = "Máy chủ khởi động lại khi đang đăng; chưa gửi lệnh đăng cuối cùng. Kiểm tra Page rồi bấm Đăng lại.";

/**
 * Đăng đều 1 video / intervalMin. Claim nguyên tử trong db.tx (BEGIN IMMEDIATE) nên nhiều tiến trình vẫn an toàn;
 * last_publish_at ghi NGAY khi claim nên restart/lỗi cũng không đăng dồn. Lỗi tạm thời ở bước start/upload được thử lại tối đa 3 lần; lỗi token/quyền tạm dừng hàng đợi; sau finish không bao giờ thử lại.
 */
export class ReelsPublisher {
  private ctx: AppContext;
  private o: PublisherOptions;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<void> | null = null;
  private stopped = true;
  private now: () => number;

  constructor(ctx: AppContext, opts: PublisherOptions = {}) {
    this.ctx = ctx;
    this.o = opts;
    this.now = opts.now ?? Date.now;
  }

  private log(msg: string): void {
    (this.o.log ?? ((m: string) => console.log(`[fbreels] ${m}`)))(msg);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.recover().catch((e) => this.log(`recover lỗi: ${redact((e as Error).message)}`));
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = this.tickOnce()
        .catch((e) => this.log(`tick lỗi: ${redact((e as Error).message)}`))
        .finally(() => {
          this.busy = null;
        });
    }, this.o.tickMs ?? 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy;
  }

  /** Khôi phục các dòng 'publishing' còn sót sau restart (không bao giờ gọi lại finish) */
  async recover(): Promise<void> {
    const cutoff = new Date(this.now() - STALE_PUBLISHING_MS).toISOString();
    const rows = this.ctx.db.all<ReelPostRow>("SELECT * FROM fb_reel_posts WHERE status = 'publishing' AND (publishing_at IS NULL OR publishing_at < ?)", cutoff);
    for (const r of rows) {
      const ws = r.workspace_id;
      if ((r.step === "finishing" || r.step === "finished") && r.fb_video_id) {
        try {
          const client = this.client(ws, getReelsConfig(this.ctx, ws));
          await client.waitUntilReady(r.fb_video_id, { maxMs: this.o.pollMaxMs, everyMs: this.o.pollEveryMs });
          this.markPublished(r.id);
        } catch (e) {
          this.markFailed(r.id, e, "Có thể video vẫn đang xử lý hoặc đã đăng; kiểm tra Page trước khi Đăng lại.");
        }
      } else {
        this.ctx.db.run("UPDATE fb_reel_posts SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND status = 'publishing'", RESTART_MSG, nowIso(), r.id);
      }
    }
  }

  private client(ws: string, cfg: ReelsConfig): GraphReelsClient {
    return new GraphReelsClient({ fetchImpl: this.ctx.fetchImpl, pageId: cfg.pageId, version: cfg.graphVersion, token: getPageToken(this.ctx, ws), sleep: this.o.sleep });
  }

  /** Claim nguyên tử bài đến lượt của một workspace. Trả null nếu chưa đến hạn / không có gì. */
  private claim(ws: string): ReelPostRow | null {
    const ctx = this.ctx;
    return ctx.db.tx(() => {
      const cfg = getReelsConfig(ctx, ws);
      if (!cfg.autoEnabled || !cfg.tokenConfigured || !cfg.pageId) return null;
      if (getReelsPause(ctx, ws)) return null; // tạm dừng do lỗi token/quyền, chờ người dùng bấm Tiếp tục
      if (ctx.db.get("SELECT 1 FROM fb_reel_posts WHERE workspace_id = ? AND status = 'publishing' LIMIT 1", ws)) return null;
      const now = this.now();
      let last = getLastPublishAt(ctx, ws);
      if (last > now) {
        last = now; // đồng hồ bị chỉnh lùi: kẹp để không kẹt vô hạn
        setLastPublishAt(ctx, ws, last);
      }
      if (last && now - last < cfg.intervalMin * 60_000) return null;
      const next = ctx.db.get<ReelPostRow>("SELECT * FROM fb_reel_posts WHERE workspace_id = ? AND status = 'approved' ORDER BY approved_at, created_at LIMIT 1", ws);
      if (!next) return null;
      const ch = ctx.db.run("UPDATE fb_reel_posts SET status = 'publishing', publishing_at = ?, attempts = attempts + 1, step = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'approved'", new Date(now).toISOString(), nowIso(), next.id).changes;
      if (!ch) return null;
      setLastPublishAt(ctx, ws, now);
      return { ...next, status: "publishing" as const };
    });
  }

  async tickOnce(): Promise<void> {
    for (const ws of configuredWorkspaces(this.ctx)) {
      try {
        sweepMissing(this.ctx, ws);
      } catch (e) {
        this.log(`sweep lỗi: ${redact((e as Error).message)}`);
      }
      const post = this.claim(ws);
      if (post) await this.publish(post);
    }
  }

  private setStep(id: string, step: string, extra: { fb_video_id?: string } = {}): void {
    if (extra.fb_video_id) this.ctx.db.run("UPDATE fb_reel_posts SET step = ?, fb_video_id = ?, updated_at = ? WHERE id = ?", step, extra.fb_video_id, nowIso(), id);
    else this.ctx.db.run("UPDATE fb_reel_posts SET step = ?, updated_at = ? WHERE id = ?", step, nowIso(), id);
  }

  private markPublished(id: string, postId: string | null = null): void {
    const now = nowIso();
    this.ctx.db.run("UPDATE fb_reel_posts SET status = 'published', fb_post_id = COALESCE(?, fb_post_id), step = 'finished', error_message = NULL, published_at = ?, updated_at = ? WHERE id = ? AND status = 'publishing'", postId, now, now, id);
  }

  private markFailed(id: string, e: unknown, hint = ""): void {
    let token = "";
    try {
      const ws = this.ctx.db.get<{ workspace_id: string }>("SELECT workspace_id FROM fb_reel_posts WHERE id = ?", id)?.workspace_id;
      token = ws ? getPageToken(this.ctx, ws) : "";
    } catch {
      /* bỏ qua */
    }
    const base = e instanceof GraphError || e instanceof Error ? e.message : String(e);
    const msg = redact(`${base}${hint ? ` ${hint}` : ""}`, [token]).replace(/EAA[A-Za-z0-9]{6,}/g, "***").slice(0, 600);
    this.ctx.db.run("UPDATE fb_reel_posts SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND status = 'publishing'", msg, nowIso(), id);
    this.log(`Đăng lỗi (${id}): ${msg}`);
  }

  /** Gọi bước an toàn (trước finish): lỗi tạm thời thì thử lại tối đa 3 lần, giãn cách tăng dần. Lỗi khác ném ngay. */
  private async withRetry<T>(fn: () => Promise<T>, post: ReelPostRow): Promise<T> {
    const sleep = this.o.sleep ?? realSleep;
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof GraphError) || !isTransientKind(e.kind) || i >= RETRY_DELAYS_MS.length) throw e;
        this.log(`Lỗi tạm thời (${post.id}), thử lại lần ${i + 1}/${RETRY_DELAYS_MS.length}`);
        await sleep(RETRY_DELAYS_MS[i]!);
      }
    }
  }

  private async publish(post: ReelPostRow): Promise<void> {
    const ctx = this.ctx;
    const ws = post.workspace_id;
    try {
      const cfg = getReelsConfig(ctx, ws);
      const asset = ctx.db.get<{ storage_path: string; file_name: string }>("SELECT storage_path, file_name FROM video_assets WHERE id = ?", post.asset_id);
      if (!asset) throw new Error("Video không còn tồn tại.");
      const file = ctx.storage.abs(asset.storage_path);
      if (!fs.existsSync(file)) throw new Error("File video đã mất khỏi kho.");
      let caption = post.caption;
      if (!caption) {
        const job = post.job_id ? ctx.db.get<{ title: string; prompt: string }>("SELECT title, prompt FROM video_batch_jobs WHERE id = ?", post.job_id) : undefined;
        caption = await buildCaption(ctx, { workspaceId: ws, prompt: job?.prompt ?? "", title: job?.title || asset.file_name }, cfg);
        ctx.db.run("UPDATE fb_reel_posts SET caption = ?, updated_at = ? WHERE id = ?", caption, nowIso(), post.id);
      }
      const client = this.client(ws, cfg);
      const { videoId, uploadUrl } = await this.withRetry(() => client.startUpload(), post);
      this.setStep(post.id, "started", { fb_video_id: videoId });
      await this.withRetry(() => client.uploadFile(uploadUrl, file), post);
      this.setStep(post.id, "uploaded");
      // Ghi step TRƯỚC khi gọi finish: nếu mơ hồ thì coi như có thể đã đăng → chỉ polling
      this.setStep(post.id, "finishing");
      const fin = await client.finish(videoId, caption);
      if (!fin.success) throw new GraphError("Facebook không xác nhận đăng thành công.", "other");
      this.setStep(post.id, "finished");
      await client.waitUntilReady(videoId, { maxMs: this.o.pollMaxMs, everyMs: this.o.pollEveryMs });
      this.markPublished(post.id, fin.postId);
      this.log(`Đã đăng Reels ${post.id}`);
    } catch (e) {
      const cur = ctx.db.get<{ step: string | null }>("SELECT step FROM fb_reel_posts WHERE id = ?", post.id);
      const ambiguous = cur?.step === "finishing" || cur?.step === "finished";
      if (e instanceof GraphError && isAuthKind(e.kind)) {
        // Lỗi token/quyền: tạm dừng cả hàng đợi của workspace để không đốt hết video
        const kind = e.kind as "token" | "permission";
        const token = (() => {
          try {
            return getPageToken(ctx, ws);
          } catch {
            return "";
          }
        })();
        setReelsPause(ctx, ws, { kind, message: redact(e.message, [token]).replace(/EAA[A-Za-z0-9]{6,}/g, "***").slice(0, 400), at: nowIso() });
        this.log(`Tạm dừng hàng đợi (${ws}): lỗi ${kind}`);
        if (!ambiguous) {
          // Chưa gửi lệnh đăng cuối: trả về hàng đợi, đăng tiếp sau khi người dùng bấm Tiếp tục
          ctx.db.run("UPDATE fb_reel_posts SET status = 'approved', step = NULL, fb_video_id = NULL, updated_at = ? WHERE id = ? AND status = 'publishing'", nowIso(), post.id);
          return;
        }
      }
      this.markFailed(post.id, e, ambiguous ? "Có thể video đã/đang được đăng; kiểm tra Page trước khi Đăng lại." : "");
    }
  }
}
