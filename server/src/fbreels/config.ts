import { z } from "zod";
import type { AppContext } from "../context.ts";
import { AppError, nowIso, safeJsonParse } from "../util.ts";

const KEY = "facebook_reels";
const STATE_KEY = "facebook_reels_state";

export interface ReelsConfig {
  pageId: string;
  graphVersion: string;
  intervalMin: number;
  autoEnabled: boolean;
  requireApproval: boolean;
  captionTemplate: string;
  hashtags: string;
  aiCaption: boolean;
  /** Mốc bật tự động lần đầu (ISO). Video tạo trước mốc này không bị đăng ngược. */
  enabledSince: string | null;
}

/** Cấu hình trả ra ngoài: KHÔNG bao giờ có token, chỉ "đã cấu hình" + 4 ký tự cuối */
export type ReelsConfigPublic = ReelsConfig & { tokenConfigured: boolean; tokenLast4: string | null; updatedAt: string | null };

export const DEFAULT_GRAPH_VERSION = "v26.0";

const DEFAULTS: ReelsConfig = {
  pageId: "",
  graphVersion: DEFAULT_GRAPH_VERSION,
  intervalMin: 60,
  autoEnabled: false,
  requireApproval: true,
  captionTemplate: "{prompt}",
  hashtags: "",
  aiCaption: false,
  enabledSince: null,
};

const patchSchema = z.object({
  pageId: z.string().trim().regex(/^\d{3,30}$/, "Page ID phải là dãy số.").optional(),
  graphVersion: z.string().trim().regex(/^v\d+\.\d+$/, "Phiên bản Graph API phải có dạng v26.0.").optional(),
  intervalMin: z.number({ invalid_type_error: "Khoảng cách đăng phải là số phút." }).int("Khoảng cách đăng phải là số nguyên.").min(5, "Khoảng cách đăng tối thiểu 5 phút.").max(1440, "Khoảng cách đăng tối đa 1440 phút.").optional(),
  autoEnabled: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  captionTemplate: z.string().max(2000, "Mẫu caption tối đa 2000 ký tự.").optional(),
  hashtags: z.string().max(500, "Hashtag tối đa 500 ký tự.").optional(),
  aiCaption: z.boolean().optional(),
  pageToken: z.string().max(1000).nullable().optional(),
});

type Row = { value_json: string; secret_enc: string | null; updated_at: string };
const readRow = (ctx: AppContext, ws: string): Row | undefined => ctx.db.get<Row>("SELECT value_json, secret_enc, updated_at FROM settings WHERE workspace_id = ? AND key = ?", ws, KEY);

export function getReelsConfig(ctx: AppContext, ws: string): ReelsConfigPublic {
  const r = readRow(ctx, ws);
  const v = safeJsonParse<Partial<ReelsConfig> & { tokenLast4?: string | null }>(r?.value_json, {});
  return {
    pageId: v.pageId ?? DEFAULTS.pageId,
    graphVersion: v.graphVersion ?? DEFAULTS.graphVersion,
    intervalMin: v.intervalMin ?? DEFAULTS.intervalMin,
    autoEnabled: v.autoEnabled ?? DEFAULTS.autoEnabled,
    requireApproval: v.requireApproval ?? DEFAULTS.requireApproval,
    captionTemplate: v.captionTemplate ?? DEFAULTS.captionTemplate,
    hashtags: v.hashtags ?? DEFAULTS.hashtags,
    aiCaption: v.aiCaption ?? DEFAULTS.aiCaption,
    enabledSince: v.enabledSince ?? null,
    tokenConfigured: Boolean(r?.secret_enc),
    tokenLast4: r?.secret_enc ? (v.tokenLast4 ?? null) : null,
    updatedAt: r?.updated_at ?? null,
  };
}

export function saveReelsConfig(ctx: AppContext, ws: string, patch: unknown): ReelsConfigPublic {
  const parsed = patchSchema.safeParse(patch ?? {});
  if (!parsed.success) throw new AppError("INVALID_FB_CONFIG", parsed.error.issues[0]?.message ?? "Cấu hình Facebook không hợp lệ.", 400);
  const p = parsed.data;
  return ctx.db.tx(() => {
    const cur = getReelsConfig(ctx, ws);
    const r = readRow(ctx, ws);
    const next: ReelsConfig = {
      pageId: p.pageId ?? cur.pageId,
      graphVersion: p.graphVersion ?? cur.graphVersion,
      intervalMin: p.intervalMin ?? cur.intervalMin,
      autoEnabled: p.autoEnabled ?? cur.autoEnabled,
      requireApproval: p.requireApproval ?? cur.requireApproval,
      captionTemplate: p.captionTemplate ?? cur.captionTemplate,
      hashtags: p.hashtags ?? cur.hashtags,
      aiCaption: p.aiCaption ?? cur.aiCaption,
      enabledSince: cur.enabledSince,
    };
    let enc = r?.secret_enc ?? null;
    let last4 = cur.tokenLast4;
    if (p.pageToken !== undefined) {
      const t = (p.pageToken ?? "").trim();
      if (t) {
        enc = ctx.secrets.encrypt(t);
        last4 = t.slice(-4);
      } else {
        enc = null;
        last4 = null;
      }
    }
    if (next.autoEnabled && !cur.autoEnabled && !next.enabledSince) next.enabledSince = nowIso();
    if (next.autoEnabled && (!next.pageId || !enc)) throw new AppError("INVALID_FB_CONFIG", "Cần nhập Page ID và Page access token trước khi bật tự động đăng.", 400);
    ctx.db.run(
      `INSERT INTO settings (workspace_id, key, value_json, secret_enc, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, secret_enc = excluded.secret_enc, updated_at = excluded.updated_at`,
      ws,
      KEY,
      JSON.stringify({ ...next, tokenLast4: last4 }),
      enc,
      nowIso(),
    );
    return getReelsConfig(ctx, ws);
  });
}

/** Chỉ publisher/test kết nối gọi. Không bao giờ đưa ra API. */
export function getPageToken(ctx: AppContext, ws: string): string {
  return ctx.secrets.decrypt(readRow(ctx, ws)?.secret_enc);
}

/** Workspace đã lưu token + pageId (publisher quét các workspace này) */
export function configuredWorkspaces(ctx: AppContext): string[] {
  return ctx.db
    .all<{ workspace_id: string; value_json: string }>("SELECT workspace_id, value_json FROM settings WHERE key = ? AND secret_enc IS NOT NULL", KEY)
    .filter((r) => Boolean(safeJsonParse<Partial<ReelsConfig>>(r.value_json, {}).pageId))
    .map((r) => r.workspace_id);
}

export function getLastPublishAt(ctx: AppContext, ws: string): number {
  const r = ctx.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE workspace_id = ? AND key = ?", ws, STATE_KEY);
  return Number(safeJsonParse<{ lastPublishAt?: number }>(r?.value_json, {}).lastPublishAt ?? 0);
}

export function setLastPublishAt(ctx: AppContext, ws: string, ms: number): void {
  ctx.db.run(
    `INSERT INTO settings (workspace_id, key, value_json, secret_enc, updated_at) VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ws,
    STATE_KEY,
    JSON.stringify({ lastPublishAt: ms }),
    nowIso(),
  );
}
