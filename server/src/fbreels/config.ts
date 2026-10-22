import { z } from "zod";
import type { AppContext } from "../context.ts";
import { AppError, newId, nowIso, safeJsonParse } from "../util.ts";

/**
 * Nhiều Page Facebook (bảng fb_pages, mỗi dòng một Page).
 * CÀI ĐẶT CHUNG cho mọi Page (settings key "facebook_reels"): mẫu caption, AI caption, phiên bản Graph.
 * THEO TỪNG PAGE: tên, Page ID, token (mã hoá), tự đăng, khoảng cách phút, không cần duyệt, hashtag, mốc bật, lần đăng cuối, trạng thái tạm dừng.
 */
const KEY = "facebook_reels";
export const MAX_PAGES = 20;
export const DEFAULT_GRAPH_VERSION = "v26.0";

export interface SharedSettings {
  graphVersion: string;
  captionTemplate: string;
  aiCaption: boolean;
}

/** Cấu hình dùng để dựng caption/Graph: cài đặt chung + hashtag của Page */
export interface ReelsConfig extends SharedSettings {
  hashtags: string;
}

export interface ReelsPause {
  kind: "token" | "permission";
  message: string;
  at: string;
}

/** Page trả ra ngoài: KHÔNG bao giờ có token/ciphertext, chỉ "đã cấu hình" + 4 ký tự cuối */
export interface PagePublic {
  id: string;
  name: string;
  pageId: string;
  tokenConfigured: boolean;
  tokenLast4: string | null;
  autoEnabled: boolean;
  intervalMin: number;
  requireApproval: boolean;
  hashtags: string;
  enabledSince: string | null;
  pause: ReelsPause | null;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_SHARED: SharedSettings = { graphVersion: DEFAULT_GRAPH_VERSION, captionTemplate: "{prompt}", aiCaption: false };

const sharedSchema = z.object({
  graphVersion: z.string().trim().regex(/^v\d+\.\d+$/, "Phiên bản Graph API phải có dạng v26.0.").optional(),
  captionTemplate: z.string().max(2000, "Mẫu caption tối đa 2000 ký tự.").optional(),
  aiCaption: z.boolean().optional(),
});

const pageSchema = z.object({
  name: z.string().trim().min(1, "Tên Page không được để trống.").max(100, "Tên Page tối đa 100 ký tự.").optional(),
  pageId: z.string().trim().regex(/^\d{3,30}$/, "Page ID phải là dãy số.").optional(),
  intervalMin: z.number({ invalid_type_error: "Khoảng cách đăng phải là số phút." }).int("Khoảng cách đăng phải là số nguyên.").min(5, "Khoảng cách đăng tối thiểu 5 phút.").max(1440, "Khoảng cách đăng tối đa 1440 phút.").optional(),
  autoEnabled: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  hashtags: z.string().max(500, "Hashtag tối đa 500 ký tự.").optional(),
  pageToken: z.string().max(1000).nullable().optional(),
});

// ---------------------------------------------------------------- cài đặt chung

export function getSharedSettings(ctx: AppContext, ws: string): SharedSettings {
  const r = ctx.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE workspace_id = ? AND key = ?", ws, KEY);
  const v = safeJsonParse<Partial<SharedSettings>>(r?.value_json, {});
  return {
    graphVersion: v.graphVersion ?? DEFAULT_SHARED.graphVersion,
    captionTemplate: v.captionTemplate ?? DEFAULT_SHARED.captionTemplate,
    aiCaption: v.aiCaption ?? DEFAULT_SHARED.aiCaption,
  };
}

/** Giữ nguyên mọi trường cũ trong value_json (kể cả pageId cũ) để rollback được; chỉ ghi đè 3 trường chung */
export function saveSharedSettings(ctx: AppContext, ws: string, patch: unknown): SharedSettings {
  const parsed = sharedSchema.safeParse(patch ?? {});
  if (!parsed.success) throw new AppError("INVALID_FB_CONFIG", parsed.error.issues[0]?.message ?? "Cài đặt Facebook không hợp lệ.", 400);
  return ctx.db.tx(() => {
    const row = ctx.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE workspace_id = ? AND key = ?", ws, KEY);
    const raw = safeJsonParse<Record<string, unknown>>(row?.value_json, {});
    const next: Record<string, unknown> = { ...raw, ...getSharedSettings(ctx, ws), ...parsed.data };
    ctx.db.run(
      `INSERT INTO settings (workspace_id, key, value_json, secret_enc, updated_at) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ws,
      KEY,
      JSON.stringify(next),
      nowIso(),
    );
    return getSharedSettings(ctx, ws);
  });
}

// ---------------------------------------------------------------- Page

/** Liệt kê cột rõ ràng: KHÔNG có token_enc (chỉ biết có token hay không qua token_set) */
interface PageRow {
  id: string;
  workspace_id: string;
  name: string;
  name_custom: number;
  page_id: string;
  token_set: number;
  token_last4: string | null;
  auto_enabled: number;
  interval_min: number;
  require_approval: number;
  hashtags: string;
  enabled_since: string | null;
  last_publish_at: number;
  pause_json: string | null;
  created_at: string;
  updated_at: string;
}
const PAGE_COLS =
  "id, workspace_id, name, name_custom, page_id, (token_enc IS NOT NULL) AS token_set, token_last4, auto_enabled, interval_min, require_approval, hashtags, enabled_since, last_publish_at, pause_json, created_at, updated_at";

function readPause(raw: string | null | undefined): ReelsPause | null {
  if (!raw) return null;
  const p = safeJsonParse<ReelsPause | null>(raw, null);
  return p && typeof p === "object" && p.kind ? p : null;
}

const toPublic = (r: PageRow): PagePublic => ({
  id: r.id,
  name: r.name,
  pageId: r.page_id,
  tokenConfigured: Boolean(r.token_set),
  tokenLast4: r.token_set ? r.token_last4 : null,
  autoEnabled: Boolean(r.auto_enabled),
  intervalMin: r.interval_min,
  requireApproval: Boolean(r.require_approval),
  hashtags: r.hashtags,
  enabledSince: r.enabled_since,
  pause: readPause(r.pause_json),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const notFound = (): AppError => new AppError("FB_PAGE_INVALID", "Page đã chọn không tồn tại hoặc đã bị xoá.", 404);

function readPageRow(ctx: AppContext, ws: string, id: string): PageRow | undefined {
  return ctx.db.get<PageRow>(`SELECT ${PAGE_COLS} FROM fb_pages WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, id, ws);
}

export function listPages(ctx: AppContext, ws: string): PagePublic[] {
  return ctx.db.all<PageRow>(`SELECT ${PAGE_COLS} FROM fb_pages WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, id`, ws).map(toPublic);
}

export function getPage(ctx: AppContext, ws: string, id: string): PagePublic {
  const r = readPageRow(ctx, ws, id);
  if (!r) throw notFound();
  return toPublic(r);
}

/** Tên Page kể cả đã xoá mềm (để hiện lịch sử hàng đợi) */
export function pageName(ctx: AppContext, id: string | null | undefined): string | null {
  if (!id) return null;
  return ctx.db.get<{ name: string }>("SELECT name FROM fb_pages WHERE id = ?", id)?.name ?? null;
}

function parsePage(body: unknown) {
  const parsed = pageSchema.safeParse(body ?? {});
  if (!parsed.success) throw new AppError("INVALID_FB_CONFIG", parsed.error.issues[0]?.message ?? "Cấu hình Page không hợp lệ.", 400);
  return parsed.data;
}

const dupPage = (): AppError => new AppError("FB_PAGE_DUPLICATE", "Page ID này đã được thêm rồi.", 409);

export function createPage(ctx: AppContext, ws: string, body: unknown): PagePublic {
  const p = parsePage(body);
  if (!p.pageId) throw new AppError("INVALID_FB_CONFIG", "Cần nhập Page ID.", 400);
  const token = (p.pageToken ?? "").trim();
  if (!token) throw new AppError("INVALID_FB_CONFIG", "Cần nhập Page access token.", 400);
  return ctx.db.tx(() => {
    const n = Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fb_pages WHERE workspace_id = ? AND deleted_at IS NULL", ws)?.n ?? 0);
    if (n >= MAX_PAGES) throw new AppError("FB_PAGE_LIMIT", `Tối đa ${MAX_PAGES} Page.`, 409);
    if (ctx.db.get("SELECT 1 FROM fb_pages WHERE workspace_id = ? AND page_id = ? AND deleted_at IS NULL", ws, p.pageId!)) throw dupPage();
    const id = newId("fbp");
    const now = nowIso();
    const auto = p.autoEnabled ?? false;
    ctx.db.run(
      `INSERT INTO fb_pages (id, workspace_id, name, name_custom, page_id, token_enc, token_last4, auto_enabled, interval_min, require_approval, hashtags, enabled_since, last_publish_at, pause_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      id,
      ws,
      p.name || `Page ${p.pageId}`,
      p.name ? 1 : 0,
      p.pageId!,
      ctx.secrets.encrypt(token),
      token.slice(-4),
      auto ? 1 : 0,
      p.intervalMin ?? 60,
      (p.requireApproval ?? true) ? 1 : 0,
      p.hashtags ?? "",
      auto ? now : null,
      now,
      now,
    );
    return getPage(ctx, ws, id);
  });
}

export function updatePage(ctx: AppContext, ws: string, id: string, body: unknown): PagePublic {
  const p = parsePage(body);
  return ctx.db.tx(() => {
    const cur = readPageRow(ctx, ws, id);
    if (!cur) throw notFound();
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (p.name !== undefined) {
      set("name", p.name);
      set("name_custom", 1);
    }
    if (p.pageId !== undefined && p.pageId !== cur.page_id) {
      if (ctx.db.get("SELECT 1 FROM fb_pages WHERE workspace_id = ? AND page_id = ? AND deleted_at IS NULL AND id <> ?", ws, p.pageId, id)) throw dupPage();
      // Đổi sang Page Facebook khác: lỗi/tạm dừng của Page cũ không còn ý nghĩa
      set("page_id", p.pageId);
      set("pause_json", null);
    }
    if (p.intervalMin !== undefined) set("interval_min", p.intervalMin);
    if (p.requireApproval !== undefined) set("require_approval", p.requireApproval ? 1 : 0);
    if (p.hashtags !== undefined) set("hashtags", p.hashtags);
    if (p.pageToken) {
      const t = p.pageToken.trim();
      if (t) {
        set("token_enc", ctx.secrets.encrypt(t));
        set("token_last4", t.slice(-4));
        set("pause_json", null);
      }
      // rỗng/null = giữ nguyên token cũ (không cho xoá token; muốn bỏ thì xoá Page)
    }
    if (p.autoEnabled !== undefined) {
      set("auto_enabled", p.autoEnabled ? 1 : 0);
      // Mỗi lần bật lại tự động là một mốc mới: video làm xong lúc tắt không bị đăng dồn
      if (p.autoEnabled && !cur.auto_enabled) set("enabled_since", nowIso());
    }
    if (sets.length) {
      set("updated_at", nowIso());
      ctx.db.run(`UPDATE fb_pages SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    }
    return getPage(ctx, ws, id);
  });
}

/** Chỉ test kết nối cập nhật tên tự động (không đè tên người dùng đã sửa) */
export function setAutoPageName(ctx: AppContext, id: string, name: string): void {
  if (!name.trim()) return;
  ctx.db.run("UPDATE fb_pages SET name = ?, updated_at = ? WHERE id = ? AND name_custom = 0", name.trim().slice(0, 100), nowIso(), id);
}

/**
 * Xoá mềm Page: xoá token ngay, tắt tự đăng, HUỶ (skipped) mọi mục chờ duyệt/đã duyệt của Page.
 * Không bao giờ chuyển mục sang Page khác. Đang có mục 'publishing' thì từ chối.
 */
export function deletePage(ctx: AppContext, ws: string, id: string): { cancelled: number } {
  return ctx.db.tx(() => {
    if (!readPageRow(ctx, ws, id)) throw notFound();
    if (ctx.db.get("SELECT 1 FROM fb_reel_posts WHERE fb_page_id = ? AND status = 'publishing' LIMIT 1", id)) throw new AppError("FB_PAGE_BUSY", "Page đang đăng một video, thử lại sau ít phút.", 409);
    const now = nowIso();
    const cancelled = ctx.db.run(
      "UPDATE fb_reel_posts SET status = 'skipped', skip_reason = ?, updated_at = ? WHERE fb_page_id = ? AND status IN ('pending_review', 'approved')",
      "Page đã bị xoá nên không đăng.",
      now,
      id,
    ).changes;
    ctx.db.run("UPDATE fb_pages SET deleted_at = ?, token_enc = NULL, token_last4 = NULL, auto_enabled = 0, updated_at = ? WHERE id = ?", now, now, id);
    return { cancelled };
  });
}

/**
 * Chỉ publisher/test kết nối gọi. Không bao giờ đưa ra API.
 * Trả cặp (Page ID Facebook, token) của ĐÚNG một dòng fb_pages: bất biến chống đăng nhầm Page.
 */
export function getPageCredentials(ctx: AppContext, fbPageRowId: string): { pageId: string; token: string; workspaceId: string } | null {
  const r = ctx.db.get<{ page_id: string; token_enc: string | null; workspace_id: string }>("SELECT page_id, token_enc, workspace_id FROM fb_pages WHERE id = ? AND deleted_at IS NULL", fbPageRowId);
  if (!r || !r.token_enc) return null;
  return { pageId: r.page_id, token: ctx.secrets.decrypt(r.token_enc), workspaceId: r.workspace_id };
}

/** Token chỉ để che trong thông báo lỗi; Page đã xoá/không giải mã được thì trả rỗng */
export function tokenForRedact(ctx: AppContext, fbPageRowId: string | null | undefined): string {
  if (!fbPageRowId) return "";
  try {
    return getPageCredentials(ctx, fbPageRowId)?.token ?? "";
  } catch {
    return "";
  }
}

/** Dùng cho caption: cài đặt chung + hashtag của Page */
export function reelsConfigFor(ctx: AppContext, ws: string, fbPageRowId: string): ReelsConfig {
  const hashtags = ctx.db.get<{ hashtags: string }>("SELECT hashtags FROM fb_pages WHERE id = ?", fbPageRowId)?.hashtags ?? "";
  return { ...getSharedSettings(ctx, ws), hashtags };
}

export interface PublishPage {
  id: string;
  workspace_id: string;
  auto_enabled: number;
  interval_min: number;
  require_approval: number;
  enabled_since: string | null;
  last_publish_at: number;
  pause_json: string | null;
}

/** Trạng thái điều phối của Page (không có token). undefined nếu Page đã xoá hoặc không còn token. */
export function getPublishPage(ctx: AppContext, id: string): PublishPage | undefined {
  return ctx.db.get<PublishPage>(
    "SELECT id, workspace_id, auto_enabled, interval_min, require_approval, enabled_since, last_publish_at, pause_json FROM fb_pages WHERE id = ? AND deleted_at IS NULL AND token_enc IS NOT NULL",
    id,
  );
}

/** Mọi Page đang bật tự đăng và có token (publisher quét các Page này) */
export function enabledPages(ctx: AppContext): { id: string; workspace_id: string }[] {
  return ctx.db.all<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM fb_pages WHERE deleted_at IS NULL AND auto_enabled = 1 AND token_enc IS NOT NULL ORDER BY created_at, id");
}

export function parsePause(raw: string | null | undefined): ReelsPause | null {
  return readPause(raw);
}

export function getPagePause(ctx: AppContext, id: string): ReelsPause | null {
  return readPause(ctx.db.get<{ pause_json: string | null }>("SELECT pause_json FROM fb_pages WHERE id = ?", id)?.pause_json);
}

export function setPagePause(ctx: AppContext, id: string, pause: ReelsPause): void {
  ctx.db.run("UPDATE fb_pages SET pause_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(pause), nowIso(), id);
}

export function clearPagePause(ctx: AppContext, ws: string, id: string): void {
  if (!readPageRow(ctx, ws, id)) throw notFound();
  ctx.db.run("UPDATE fb_pages SET pause_json = NULL, updated_at = ? WHERE id = ?", nowIso(), id);
}

export function setPageLastPublishAt(ctx: AppContext, id: string, ms: number): void {
  ctx.db.run("UPDATE fb_pages SET last_publish_at = ? WHERE id = ?", ms, id);
}

// ---------------------------------------------------------------- chọn Page cho batch

/**
 * Luật DUY NHẤT cho "Đăng lên Page" khi tạo batch (BatchService.createBatch gọi hàm này trước khi INSERT).
 * Trả: "none" | id Page | null (chưa cấu hình Page nào và không chọn gì → batch không đăng).
 * enforce=false (dryRun/ước tính): chỉ kiểm giá trị nếu có, không ép phải chọn.
 */
export function resolveFbTarget(ctx: AppContext, ws: string, input: string | null | undefined, enforce = true): string | null {
  const v = typeof input === "string" ? input.trim() : "";
  if (v === "none") return "none";
  if (v) {
    if (!readPageRow(ctx, ws, v)) throw new AppError("FB_PAGE_INVALID", "Page đã chọn không tồn tại hoặc đã bị xoá.", 400);
    return v;
  }
  const pages = listPages(ctx, ws);
  if (pages.length && enforce) {
    throw new AppError(
      "FB_PAGE_REQUIRED",
      `Bạn phải chọn Page đăng Facebook (hoặc chọn 'Không đăng lên Facebook' = "none") trước khi tạo batch. Các Page hiện có: ${pages.map((p) => `${p.name} (${p.id})`).join(", ")}.`,
      400,
      { pages: pages.map((p) => ({ id: p.id, name: p.name })) },
    );
  }
  return null;
}
