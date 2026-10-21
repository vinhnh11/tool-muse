import type { AppContext } from "../context.ts";
import { AppError, newId, nowIso } from "../util.ts";
import { getReelsConfig } from "./config.ts";
import { checkReelEligibility } from "./eligibility.ts";

export type ReelStatusCode = "pending_review" | "approved" | "publishing" | "published" | "failed" | "skipped" | "rejected";

export const STATUS_LABEL: Record<ReelStatusCode, string> = {
  pending_review: "Chờ duyệt",
  approved: "Đã duyệt, trong hàng đăng",
  publishing: "Đang đăng",
  published: "Đã đăng",
  failed: "Lỗi",
  skipped: "Bỏ qua",
  rejected: "Đã từ chối",
};

export interface ReelPostRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  job_id: string | null;
  status: ReelStatusCode;
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

/**
 * Xếp video vừa xong vào hàng đăng. Idempotent (UNIQUE asset_id). Chưa cấu hình Facebook thì bỏ qua.
 * Trả true nếu có dòng mới.
 */
export function enqueueReel(ctx: AppContext, assetId: string): boolean {
  const a = ctx.db.get<AssetInfo>(`SELECT ${ASSET_COLS} FROM video_assets WHERE id = ?`, assetId);
  if (!a || a.kind !== "generated") return false;
  const cfg = getReelsConfig(ctx, a.workspace_id);
  if (!cfg.tokenConfigured || !cfg.pageId) return false;
  const el = checkReelEligibility({ durationSec: a.duration_sec, width: a.width, height: a.height, mime: a.mime, fileName: a.file_name, sizeBytes: a.size_bytes });
  const now = nowIso();
  const status: ReelStatusCode = !el.ok ? "skipped" : cfg.requireApproval ? "pending_review" : "approved";
  const r = ctx.db.run(
    `INSERT OR IGNORE INTO fb_reel_posts (id, workspace_id, asset_id, job_id, status, skip_reason, approved_by, approved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("fbr"),
    a.workspace_id,
    a.id,
    a.source_job_id,
    status,
    el.ok ? null : el.reason,
    status === "approved" ? "auto" : null,
    status === "approved" ? now : null,
    now,
    now,
  );
  return r.changes > 0;
}

/** Quét video 'generated' đã xong nhưng chưa vào hàng (bị lỡ móc), chỉ video tạo sau mốc bật tính năng */
export function sweepMissing(ctx: AppContext, ws: string): number {
  const cfg = getReelsConfig(ctx, ws);
  if (!cfg.enabledSince || !cfg.tokenConfigured || !cfg.pageId) return 0;
  const rows = ctx.db.all<{ id: string }>(
    `SELECT a.id FROM video_assets a JOIN video_batch_jobs j ON j.id = a.source_job_id AND j.status = 'completed' AND j.output_asset_id = a.id
     WHERE a.workspace_id = ? AND a.kind = 'generated' AND a.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM fb_reel_posts p WHERE p.asset_id = a.id)
     ORDER BY a.created_at`,
    ws,
    cfg.enabledSince,
  );
  let n = 0;
  for (const r of rows) if (enqueueReel(ctx, r.id)) n++;
  return n;
}

export interface ReelItem {
  id: string;
  assetId: string;
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
  attempts: number;
  approvedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export function listQueue(ctx: AppContext, ws: string, status?: string): { items: ReelItem[] } {
  const rows = ctx.db.all<ReelPostRow & { file_name: string; duration_sec: number | null; width: number | null; height: number | null; thumbnail_path: string | null; title: string | null; prompt: string | null }>(
    `SELECT p.*, a.file_name, a.duration_sec, a.width, a.height, a.thumbnail_path, j.title, j.prompt
     FROM fb_reel_posts p JOIN video_assets a ON a.id = p.asset_id LEFT JOIN video_batch_jobs j ON j.id = p.job_id
     WHERE p.workspace_id = ? ${status ? "AND p.status = ?" : ""} ORDER BY p.created_at DESC LIMIT 500`,
    ...(status ? [ws, status] : [ws]),
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      assetId: r.asset_id,
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
      attempts: r.attempts,
      approvedAt: r.approved_at,
      publishedAt: r.published_at,
      createdAt: r.created_at,
    })),
  };
}

function getPost(ctx: AppContext, ws: string, id: string): ReelPostRow {
  const r = ctx.db.get<ReelPostRow>("SELECT * FROM fb_reel_posts WHERE id = ? AND workspace_id = ?", id, ws);
  if (!r) throw new AppError("NOT_FOUND", "Không tìm thấy mục trong hàng đăng.", 404);
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
  const a = ctx.db.get<AssetInfo>(`SELECT ${ASSET_COLS} FROM video_assets WHERE id = ?`, r.asset_id);
  const el = a ? checkReelEligibility({ durationSec: a.duration_sec, width: a.width, height: a.height, mime: a.mime, fileName: a.file_name, sizeBytes: a.size_bytes }) : ({ ok: false, reason: "Video không còn tồn tại." } as const);
  if (!el.ok) {
    ctx.db.run("UPDATE fb_reel_posts SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE id = ? AND status = ?", el.reason, nowIso(), id, r.status);
    throw new AppError("NOT_ELIGIBLE", `Video không đủ điều kiện đăng Reels: ${el.reason}`, 409);
  }
  const now = nowIso();
  const ch = ctx.db.run(
    "UPDATE fb_reel_posts SET status = 'approved', skip_reason = NULL, error_message = NULL, fb_video_id = NULL, fb_post_id = NULL, step = NULL, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = ?",
    userId,
    now,
    now,
    id,
    r.status,
  ).changes;
  if (!ch) throw conflict("đăng lại", r);
}

/** Xoá khỏi hàng: chỉ xoá dòng hàng đợi, KHÔNG đụng video_assets/file */
export function remove(ctx: AppContext, ws: string, id: string): void {
  const r = getPost(ctx, ws, id);
  const ch = ctx.db.run("DELETE FROM fb_reel_posts WHERE id = ? AND status <> 'publishing'", id).changes;
  if (!ch) throw conflict("xoá khỏi hàng", r);
}
