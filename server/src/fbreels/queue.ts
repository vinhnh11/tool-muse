import type { AppContext } from "../context.ts";
import { AppError, newId, nowIso } from "../util.ts";
import { normalizeShopeeUrl } from "./shopee.ts";
import { getPublishPage, pageName, parsePause, type ReelsPause } from "./config.ts";
import { checkReelEligibility } from "./eligibility.ts";

/** removed = người dùng đã xoá khỏi hàng (dòng giữ lại làm dấu để sweepMissing không xếp lại) */
export type ReelStatusCode = "pending_review" | "approved" | "publishing" | "published" | "failed" | "skipped" | "rejected" | "removed";

export const STATUS_LABEL: Record<ReelStatusCode, string> = {
  pending_review: "Chờ duyệt",
  approved: "Đã duyệt, trong hàng đăng",
  publishing: "Đang đăng",
  published: "Đã đăng",
  failed: "Lỗi",
  skipped: "Bỏ qua",
  rejected: "Đã từ chối",
  removed: "Đã xoá khỏi hàng",
};

export type CommentStatus = "none" | "pending" | "done" | "failed";

export interface ReelPostRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  job_id: string | null;
  /** id nội bộ fb_pages.id: Page đích của mục này, cố định từ lúc xếp hàng */
  fb_page_id: string | null;
  status: ReelStatusCode;
  /** Link Shopee SAO CHÉP từ batch lúc xếp hàng, không JOIN lại batch */
  shopee_url: string | null;
  comment_status: CommentStatus;
  comment_error: string | null;
  fb_comment_id: string | null;
  comment_attempts: number;
  next_comment_at: string | null;
  caption: string | null;
  skip_reason: string | null;
  error_message: string | null;
  fb_video_id: string | null;
  fb_post_id: string | null;
  step: string | null;
  attempts: number;
  approved_by: string | null;
  approved_at: string | null;
  publishing_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AssetInfo {
  id: string;
  workspace_id: string;
  kind: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  source_job_id: string | null;
  created_at: string;
}

const ASSET_COLS = "id, workspace_id, kind, file_name, mime, size_bytes, duration_sec, width, height, source_job_id, created_at";

/** Page đích của video: batch của job tạo ra video → video_batches.fb_page_id (NULL/'none' = không đăng) */
function targetOf(ctx: AppContext, jobId: string | null): { pageId: string | null; shopeeUrl: string | null } {
  if (!jobId) return { pageId: null, shopeeUrl: null };
  const r = ctx.db.get<{ fb_page_id: string | null; shopee_url: string | null }>("SELECT b.fb_page_id, b.shopee_url FROM video_batch_jobs j JOIN video_batches b ON b.id = j.batch_id WHERE j.id = ?", jobId);
  const v = r?.fb_page_id ?? null;
  return v && v !== "none" ? { pageId: v, shopeeUrl: r?.shopee_url || null } : { pageId: null, shopeeUrl: null };
}

/**
 * Xếp video vừa xong vào hàng đăng của ĐÚNG Page mà batch đã chọn. Idempotent (UNIQUE asset_id).
 * Batch không chọn Page / chọn "Không đăng" / Page đã xoá hoặc tắt tự động đăng thì bỏ qua. Video không thuộc batch nào cũng không đăng.
 * Trả true nếu có dòng mới.
 */
export function enqueueReel(ctx: AppContext, assetId: string): boolean {
  const a = ctx.db.get<AssetInfo>(`SELECT ${ASSET_COLS} FROM video_assets WHERE id = ?`, assetId);
  if (!a || a.kind !== "generated") return false;
  const { pageId: pageRowId, shopeeUrl } = targetOf(ctx, a.source_job_id);
  if (!pageRowId) return false;
  const page = getPublishPage(ctx, pageRowId);
  if (!page || page.workspace_id !== a.workspace_id || !page.auto_enabled) return false;
  const el = checkReelEligibility({ durationSec: a.duration_sec, width: a.width, height: a.height, mime: a.mime, fileName: a.file_name, sizeBytes: a.size_bytes });
  const now = nowIso();
  const status: ReelStatusCode = !el.ok ? "skipped" : page.require_approval ? "pending_review" : "approved";
  const r = ctx.db.run(
    `INSERT OR IGNORE INTO fb_reel_posts (id, workspace_id, asset_id, job_id, fb_page_id, status, skip_reason, approved_by, approved_at, shopee_url, comment_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("fbr"),
    a.workspace_id,
    a.id,
    a.source_job_id,
    page.id,
    status,
    el.ok ? null : el.reason,
    status === "approved" ? "auto" : null,
    status === "approved" ? now : null,
    shopeeUrl,
    shopeeUrl && status !== "skipped" ? "pending" : "none",
    now,
    now,
  );
  return r.changes > 0;
}

/** Quét video 'generated' của các batch chọn Page này, đã xong nhưng chưa vào hàng (bị lỡ móc), chỉ video tạo sau mốc bật tự đăng của Page */
export function sweepMissing(ctx: AppContext, pageRowId: string): number {
  const page = getPublishPage(ctx, pageRowId);
  if (!page || !page.auto_enabled || !page.enabled_since) return 0;
  const rows = ctx.db.all<{ id: string }>(
    `SELECT a.id FROM video_assets a JOIN video_batch_jobs j ON j.id = a.source_job_id AND j.status = 'completed' AND j.output_asset_id = a.id
     JOIN video_batches b ON b.id = j.batch_id AND b.fb_page_id = ?
     WHERE a.workspace_id = ? AND a.kind = 'generated' AND a.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM fb_reel_posts p WHERE p.asset_id = a.id)
     ORDER BY a.created_at`,
    page.id,
    page.workspace_id,
    page.enabled_since,
  );
  let n = 0;
  for (const r of rows) if (enqueueReel(ctx, r.id)) n++;
  return n;
}

export interface ReelItem {
  id: string;
  assetId: string;
  pageId: string | null;
  pageName: string | null;
  status: ReelStatusCode;
  statusLabel: string;
  title: string;
  prompt: string;
  fileName: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  skipReason: string | null;
  errorMessage: string | null;
  caption: string | null;
  fbVideoId: string | null;
  shopeeUrl: string | null;
  commentStatus: CommentStatus;
  commentError: string | null;
  fbCommentId: string | null;
  commentAttempts: number;
  attempts: number;
  approvedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export function listQueue(ctx: AppContext, ws: string, f: { status?: string; pageId?: string } = {}): { items: ReelItem[]; pauses: Record<string, ReelsPause> } {
  const { status, pageId } = f;
  const params: string[] = [ws];
  if (status) params.push(status);
  if (pageId) params.push(pageId);
  const rows = ctx.db.all<ReelPostRow & { file_name: string; duration_sec: number | null; width: number | null; height: number | null; thumbnail_path: string | null; title: string | null; prompt: string | null }>(
    `SELECT p.*, a.file_name, a.duration_sec, a.width, a.height, a.thumbnail_path, j.title, j.prompt
     FROM fb_reel_posts p JOIN video_assets a ON a.id = p.asset_id LEFT JOIN video_batch_jobs j ON j.id = p.job_id
     WHERE p.workspace_id = ? AND p.status <> 'removed' ${status ? "AND p.status = ?" : ""} ${pageId ? "AND p.fb_page_id = ?" : ""} ORDER BY p.created_at DESC LIMIT 500`,
    ...params,
  );
  const pauses: Record<string, ReelsPause> = {};
  for (const pg of ctx.db.all<{ id: string; pause_json: string | null }>("SELECT id, pause_json FROM fb_pages WHERE workspace_id = ? AND deleted_at IS NULL AND pause_json IS NOT NULL", ws)) {
    const p = parsePause(pg.pause_json);
    if (p) pauses[pg.id] = p;
  }
  return {
    pauses,
    items: rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
      pageId: r.fb_page_id,
      pageName: pageName(ctx, r.fb_page_id),
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] ?? r.status,
      title: r.title || r.file_name,
      prompt: (r.prompt ?? "").slice(0, 200),
      fileName: r.file_name,
      durationSec: r.duration_sec,
      width: r.width,
      height: r.height,
      thumbnailUrl: r.thumbnail_path ? `/api/assets/${r.asset_id}/thumbnail` : null,
      skipReason: r.skip_reason,
      errorMessage: r.error_message,
      caption: r.caption,
      fbVideoId: r.fb_video_id,
      shopeeUrl: r.shopee_url,
      commentStatus: r.comment_status,
      commentError: r.comment_error,
      fbCommentId: r.fb_comment_id,
      commentAttempts: r.comment_attempts,
      attempts: r.attempts,
      approvedAt: r.approved_at,
      publishedAt: r.published_at,
      createdAt: r.created_at,
    })),
  };
}

function getPost(ctx: AppContext, ws: string, id: string): ReelPostRow {
  const r = ctx.db.get<ReelPostRow>("SELECT * FROM fb_reel_posts WHERE id = ? AND workspace_id = ?", id, ws);
  if (!r || r.status === "removed") throw new AppError("NOT_FOUND", "Không tìm thấy mục trong hàng đăng.", 404);
  return r;
}

function conflict(action: string, r: ReelPostRow): AppError {
  return new AppError("INVALID_STATE", `Không thể ${action} khi đang ở trạng thái "${STATUS_LABEL[r.status] ?? r.status}".`, 409);
}

export function approve(ctx: AppContext, ws: string, id: string, userId: string): ReelItem {
  const r = getPost(ctx, ws, id);
  const now = nowIso();
  const ch = ctx.db.run("UPDATE fb_reel_posts SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'pending_review'", userId, now, now, id).changes;
  if (!ch) throw conflict("duyệt", r);
  return listQueue(ctx, ws).items.find((x) => x.id === id)!;
}

export function reject(ctx: AppContext, ws: string, id: string): void {
  const r = getPost(ctx, ws, id);
  const ch = ctx.db.run("UPDATE fb_reel_posts SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'pending_review'", nowIso(), id).changes;
  if (!ch) throw conflict("từ chối", r);
}

/** Đăng lại: kiểm tra lại điều kiện video rồi đưa về 'approved' (người dùng đã chủ động bấm) */
export function retry(ctx: AppContext, ws: string, id: string, userId: string): void {
  const r = getPost(ctx, ws, id);
  if (!["failed", "skipped", "rejected"].includes(r.status)) throw conflict("đăng lại", r);
  const page = r.fb_page_id ? getPublishPage(ctx, r.fb_page_id) : undefined;
  if (!page) throw new AppError("FB_PAGE_GONE", "Page của mục này đã bị xoá, không thể đăng lại.", 409);
  const a = ctx.db.get<AssetInfo>(`SELECT ${ASSET_COLS} FROM video_assets WHERE id = ?`, r.asset_id);
  const el = a ? checkReelEligibility({ durationSec: a.duration_sec, width: a.width, height: a.height, mime: a.mime, fileName: a.file_name, sizeBytes: a.size_bytes }) : ({ ok: false, reason: "Video không còn tồn tại." } as const);
  if (!el.ok) {
    ctx.db.run("UPDATE fb_reel_posts SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ? AND status = ?", el.reason, nowIso(), id, r.status);
    throw new AppError("NOT_ELIGIBLE", `Video không đủ điều kiện đăng Reels: ${el.reason}`, 409);
  }
  const now = nowIso();
  // Video từng bị từ chối mà đang bắt buộc duyệt thì phải qua bước duyệt lại
  const needReview = r.status === "rejected" && Boolean(page.require_approval);
  const ch = ctx.db.run(
    "UPDATE fb_reel_posts SET status = ?, skip_reason = NULL, error_message = NULL, fb_video_id = NULL, fb_post_id = NULL, step = NULL, approved_by = ?, approved_at = ?, updated_at = ?, comment_status = ?, comment_error = NULL, comment_attempts = 0, next_comment_at = NULL WHERE id = ? AND status = ?",
    needReview ? "pending_review" : "approved",
    needReview ? null : userId,
    needReview ? null : now,
    now,
    r.shopee_url ? "pending" : "none",
    id,
    r.status,
  ).changes;
  if (!ch) throw conflict("đăng lại", r);
}

/** Xoá khỏi hàng: đánh dấu 'removed' (KHÔNG DELETE để sweepMissing không xếp lại → tránh đăng trùng). Không đụng video_assets/file */
export function remove(ctx: AppContext, ws: string, id: string): void {
  const r = getPost(ctx, ws, id);
  const ch = ctx.db.run("UPDATE fb_reel_posts SET status = 'removed', updated_at = ? WHERE id = ? AND status NOT IN ('publishing', 'removed')", nowIso(), id).changes;
  if (!ch) throw conflict("xoá khỏi hàng", r);
}

/** Sửa link Shopee của MỘT bài, chỉ khi đang chờ duyệt. Link rỗng = bỏ link. Caption dựng lại khi đăng. */
export function setShopeeUrl(ctx: AppContext, ws: string, id: string, raw: unknown): ReelItem {
  const r = getPost(ctx, ws, id);
  const url = normalizeShopeeUrl(raw);
  const ch = ctx.db.run("UPDATE fb_reel_posts SET shopee_url = ?, comment_status = ?, comment_error = NULL, comment_attempts = 0, next_comment_at = NULL, caption = NULL, updated_at = ? WHERE id = ? AND status = 'pending_review'", url, url ? "pending" : "none", nowIso(), id).changes;
  if (!ch) throw conflict("sửa link Shopee", r);
  return listQueue(ctx, ws).items.find((x) => x.id === id)!;
}

/** Xếp lại bình luận lỗi để publisher thử ở tick kế. Chỉ khi bài đã đăng, chưa có bình luận nào. */
export function retryComment(ctx: AppContext, ws: string, id: string): void {
  const r = getPost(ctx, ws, id);
  const ch = ctx.db.run(
    "UPDATE fb_reel_posts SET comment_status = 'pending', comment_error = NULL, comment_attempts = 0, next_comment_at = NULL, updated_at = ? WHERE id = ? AND status = 'published' AND comment_status = 'failed' AND fb_comment_id IS NULL AND shopee_url IS NOT NULL",
    nowIso(),
    id,
  ).changes;
  if (!ch) throw new AppError("INVALID_STATE", `Không thể thử bình luận lại: bài phải đã đăng, bình luận đang lỗi và chưa có bình luận nào (trạng thái hiện tại: "${STATUS_LABEL[r.status] ?? r.status}").`, 409);
}
