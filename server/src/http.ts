import { getProEdit, startProEdit } from "./proedit.ts";
import { renderEdit } from "./autoedit.ts";
import { mergeVideos } from "./merge.ts";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import Busboy from "busboy";
import { ROOT_DIR } from "./config.ts";
import type { AppContext } from "./context.ts";
import * as auth from "./auth.ts";
import { audit, eventToPublic, recordEvent, wake, type EventRow } from "./events.ts";
import { BatchService, type Actor, type BatchConfig, type BatchPromptInput } from "./batches.ts";
import { ChatService } from "./chat.ts";
import { DeployService, type DeploySelection } from "./deploy.ts";
import { ExportService } from "./exporter.ts";
import { PromptService } from "./promptgen.ts";
import { checkList, detectFormat, parsePrompts } from "./prompts.ts";
import { PROVIDER_TYPES } from "./providers/registry.ts";
import { listSkills, SessionService } from "./sessions.ts";
import { mimeOf } from "./storage.ts";
import { invokeTool, TOOLS, toJsonSchema } from "./tools.ts";
import { nudgeJob } from "./scheduler.ts";
import { AppError, redact, timingSafeEqualStr } from "./util.ts";
import { clearReelsPause, getPageToken, getReelsConfig, saveReelsConfig } from "./fbreels/config.ts";
import { GraphReelsClient } from "./fbreels/graph.ts";
import { approve as reelApprove, listQueue, reject as reelReject, remove as reelRemove, retry as reelRetry } from "./fbreels/queue.ts";

const COOKIE = "bvs_session";

interface AuthedRequest extends Request {
  principal?: auth.Principal;
  workspaceId?: string;
  sessionToken?: string;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

type Handler = (req: AuthedRequest, res: Response) => Promise<unknown> | unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req as AuthedRequest, res))
    .then((out) => {
      if (out !== undefined && !res.headersSent) res.json(out);
    })
    .catch(next);
};

const actorOf = (req: AuthedRequest): Actor => ({ userId: req.principal!.user.id, kind: req.principal!.via === "ui" ? "ui" : "api-token" });
const ws = (req: AuthedRequest): string => req.workspaceId!;
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(express.json({ limit: "5mb" }));

  const batches = new BatchService(ctx);
  const prompts = new PromptService(ctx);
  const sessions = new SessionService(ctx);
  const chat = new ChatService(ctx);
  const exporter = new ExportService(ctx);
  const deployer = new DeployService(ctx);

  // ------------------------------------------------------------ không cần đăng nhập

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.get("/api/auth/setup-status", (_req, res) => {
    res.json({ needsSetup: auth.countUsers(ctx.db) === 0 });
  });

  /** Tạo tài khoản đầu tiên - chỉ khi DB chưa có người dùng nào */
  app.post(
    "/api/auth/setup",
    h((req, res) => {
      if (auth.countUsers(ctx.db) > 0) throw new AppError("ALREADY_SETUP", "Đã có tài khoản - hãy đăng nhập.", 409);
      const { username, password } = req.body ?? {};
      const { user, workspaceId } = auth.createUser(ctx.db, String(username ?? ""), String(password ?? ""), "admin");
      ctx.providers.ensureMock(workspaceId);
      audit(ctx.db, { workspaceId, userId: user.id, actor: "ui", action: "auth.setup" });
      const s = auth.login(ctx.db, String(username), String(password));
      setSessionCookie(res, s.token, s.expiresAt);
      return { user: s.user };
    }),
  );

  app.post(
    "/api/auth/login",
    h((req, res) => {
      const { username, password } = req.body ?? {};
      try {
        const s = auth.login(ctx.db, String(username ?? ""), String(password ?? ""));
        setSessionCookie(res, s.token, s.expiresAt);
        audit(ctx.db, { userId: s.user.id, actor: "ui", action: "auth.login" });
        return { user: s.user };
      } catch (e) {
        audit(ctx.db, { actor: "ui", action: "auth.login_failed", data: { username: String(username ?? "").slice(0, 40) } });
        throw e;
      }
    }),
  );

  /** Webhook provider: chỉ là tín hiệu → poll lại API provider; xác thực bằng token bí mật trong URL */
  app.post(
    "/api/webhooks/provider/:configId/:token",
    h((req) => {
      const row = ctx.providers.rowById(String(req.params.configId));
      if (!row || !row.webhook_secret_enc) throw new AppError("NOT_FOUND", "Not found", 404);
      const secret = ctx.secrets.decrypt(row.webhook_secret_enc);
      if (!timingSafeEqualStr(secret, String(req.params.token))) throw new AppError("NOT_FOUND", "Not found", 404);
      const remoteId = String((req.body as { id?: string })?.id ?? "");
      if (!remoteId) return { ok: true, matched: false };
      return { ok: true, matched: nudgeJob(ctx, row.id, remoteId) };
    }),
  );

  // ------------------------------------------------------------ xác thực

  app.use("/api", (req: AuthedRequest, _res, next) => {
    try {
      const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (bearer) {
        const u = auth.userFromApiToken(ctx.db, bearer);
        if (!u) throw new AppError("UNAUTHORIZED", "API token không hợp lệ.", 401);
        req.principal = { user: u, via: "api-token" };
      } else {
        const token = parseCookies(req.headers.cookie)[COOKIE];
        const u = token ? auth.userFromSession(ctx.db, token) : null;
        if (!u) throw new AppError("UNAUTHORIZED", "Chưa đăng nhập.", 401);
        req.principal = { user: u, via: "ui" };
        req.sessionToken = token;
        // Chống CSRF: request ghi bằng cookie phải có header tùy biến (trình duyệt khác origin không gửi được nếu không qua CORS)
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-bvs-request"] !== "1") throw new AppError("CSRF", "Thiếu header X-BVS-Request.", 403);
      }
      const requested = (req.headers["x-workspace-id"] as string | undefined) || (req.query.ws as string | undefined) || null;
      req.workspaceId = auth.resolveWorkspace(ctx.db, req.principal.user.id, requested);
      next();
    } catch (e) {
      next(e);
    }
  });

  app.get(
    "/api/auth/me",
    h((req) => ({ user: req.principal!.user, via: req.principal!.via, workspaceId: ws(req), workspaces: auth.workspacesOf(ctx.db, req.principal!.user.id) })),
  );
  app.post(
    "/api/auth/logout",
    h((req, res) => {
      if (req.sessionToken) auth.logout(ctx.db, req.sessionToken);
      res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return { ok: true };
    }),
  );

  // Token API cho Hermes / CLI / MCP
  app.get("/api/tokens", h((req) => ({ tokens: auth.listApiTokens(ctx.db, req.principal!.user.id) })));
  app.post(
    "/api/tokens",
    h((req) => {
      const t = auth.createApiToken(ctx.db, req.principal!.user.id, String(req.body?.name ?? "token").slice(0, 60));
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: "ui", action: "token.create", targetId: t.id });
      return { id: t.id, token: t.token, note: "Chỉ hiện MỘT lần - lưu lại ngay." };
    }),
  );
  app.delete(
    "/api/tokens/:id",
    h((req) => {
      const ok = auth.revokeApiToken(ctx.db, req.principal!.user.id, String(req.params.id));
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: "ui", action: "token.revoke", targetId: String(req.params.id) });
      return { ok };
    }),
  );

  // ------------------------------------------------------------ cài đặt LLM

  app.get("/api/settings/llm", h((req) => ctx.llm.getSettings(ws(req))));
  app.put(
    "/api/settings/llm",
    h((req) => {
      const b = req.body ?? {};
      const s = ctx.llm.saveSettings(ws(req), { baseUrl: b.baseUrl, textModel: b.textModel, visionModel: b.visionModel, audioModel: b.audioModel, apiKey: b.apiKey === undefined ? undefined : b.apiKey });
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: "ui", action: "settings.llm", data: { baseUrl: s.baseUrl, textModel: s.textModel, visionModel: s.visionModel, audioModel: s.audioModel, apiKeyChanged: b.apiKey !== undefined } });
      return s;
    }),
  );
  app.get(
    "/api/settings/system",
    h(() => ({ workerMode: ctx.cfg.workerMode, editInboxConfigured: Boolean(ctx.cfg.editInboxDir), webhookBaseConfigured: Boolean(ctx.cfg.publicBaseUrl) })),
  );

  // ------------------------------------------------------------ Facebook Reels (tự đăng)

  const uid = (req: AuthedRequest): string => req.principal!.user.id;
  const fbAudit = (req: AuthedRequest, action: string, targetId?: string, data?: unknown): void =>
    audit(ctx.db, { workspaceId: ws(req), userId: uid(req), actor: actorOf(req).kind, action, targetType: "fb_reel", targetId, data });
  app.get("/api/facebook/reels/config", h((req) => getReelsConfig(ctx, ws(req))));
  app.put(
    "/api/facebook/reels/config",
    h((req) => {
      const b = req.body ?? {};
      const out = saveReelsConfig(ctx, ws(req), b);
      fbAudit(req, "fb.reel.config", undefined, { pageId: out.pageId, graphVersion: out.graphVersion, intervalMin: out.intervalMin, autoEnabled: out.autoEnabled, requireApproval: out.requireApproval, tokenChanged: b.pageToken !== undefined });
      return out;
    }),
  );
  app.post(
    "/api/facebook/reels/config/test",
    h(async (req) => {
      const cfg = getReelsConfig(ctx, ws(req));
      if (!cfg.pageId || !cfg.tokenConfigured) throw new AppError("FB_NOT_CONFIGURED", "Chưa nhập Page ID và Page access token.", 409);
      const token = getPageToken(ctx, ws(req));
      try {
        const info = await new GraphReelsClient({ fetchImpl: ctx.fetchImpl, pageId: cfg.pageId, version: cfg.graphVersion, token }).pageInfo();
        return { ok: true, pageName: info.name, message: `Kết nối được Page "${info.name}".` };
      } catch (e) {
        return { ok: false, message: redact((e as Error).message, [token]) };
      }
    }),
  );
  app.post(
    "/api/facebook/reels/resume",
    h((req) => {
      clearReelsPause(ctx, ws(req));
      fbAudit(req, "fb.reel.resume");
      return { ok: true };
    }),
  );
  app.get("/api/facebook/reels/queue", h((req) => listQueue(ctx, ws(req), req.query.status ? String(req.query.status) : undefined)));
  app.post(
    "/api/facebook/reels/queue/:id/approve",
    h((req) => {
      const item = reelApprove(ctx, ws(req), String(req.params.id), uid(req));
      fbAudit(req, "fb.reel.approve", item.id);
      return item;
    }),
  );
  app.post(
    "/api/facebook/reels/queue/:id/reject",
    h((req) => {
      reelReject(ctx, ws(req), String(req.params.id));
      fbAudit(req, "fb.reel.reject", String(req.params.id));
      return { ok: true };
    }),
  );
  app.post(
    "/api/facebook/reels/queue/:id/retry",
    h((req) => {
      reelRetry(ctx, ws(req), String(req.params.id), uid(req));
      fbAudit(req, "fb.reel.retry", String(req.params.id));
      return { ok: true };
    }),
  );
  app.delete(
    "/api/facebook/reels/queue/:id",
    h((req) => {
      reelRemove(ctx, ws(req), String(req.params.id));
      fbAudit(req, "fb.reel.remove", String(req.params.id));
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------ provider

  app.get("/api/providers/types", h(() => ({ types: PROVIDER_TYPES })));
  app.get("/api/providers", h((req) => ({ providers: ctx.providers.list(ws(req)) })));
  app.post(
    "/api/providers",
    h((req) => {
      const p = ctx.providers.create(ws(req), req.body ?? {});
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "provider.create", targetId: p.id, data: { type: p.providerType, hasApiKey: p.hasApiKey } });
      return p;
    }),
  );
  app.patch(
    "/api/providers/:id",
    h((req) => {
      const p = ctx.providers.update(ws(req), String(req.params.id), req.body ?? {});
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "provider.update", targetId: p.id, data: { fields: Object.keys(req.body ?? {}).map((k) => (k === "apiKey" ? "apiKey(changed)" : k)) } });
      return p;
    }),
  );
  app.delete(
    "/api/providers/:id",
    h((req) => {
      ctx.providers.remove(ws(req), String(req.params.id));
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "provider.disable", targetId: String(req.params.id) });
      return { ok: true };
    }),
  );
  app.post("/api/providers/:id/test", h(async (req) => ctx.providers.test(ws(req), String(req.params.id))));

  // ------------------------------------------------------------ phiên + skill + chat

  app.get("/api/skills", h(() => ({ skills: listSkills().map((s) => ({ id: s.id, name: s.name, description: s.description, genres: s.genres })) })));
  app.get("/api/sessions", h((req) => ({ sessions: sessions.list(ws(req)) })));
  app.post("/api/sessions", h((req) => sessions.create(ws(req), req.principal!.user.id, req.body?.title)));
  app.get("/api/sessions/:id", h((req) => sessions.get(ws(req), String(req.params.id))));
  app.patch("/api/sessions/:id", h((req) => sessions.update(ws(req), String(req.params.id), req.body ?? {})));
  app.get("/api/sessions/:id/chat", h((req) => ({ messages: chat.history(ws(req), String(req.params.id)) })));
  app.post(
    "/api/sessions/:id/chat",
    h(async (req) => {
      const b = req.body ?? {};
      const msgs = await chat.send(ws(req), req.principal!.user.id, String(req.params.id), String(b.message ?? ""), {
        mode: b.mode,
        skillIds: b.skillIds,
        providerConfigId: b.providerConfigId,
        modelId: b.modelId,
        attachments: b.attachments,
      });
      return { messages: msgs };
    }),
  );

  // ------------------------------------------------------------ asset

  app.get(
    "/api/assets",
    h((req) => {
      const where = ["workspace_id = ?"];
      const p: (string | number)[] = [ws(req)];
      if (req.query.kind) {
        where.push("kind = ?");
        p.push(String(req.query.kind));
      }
      if (req.query.sessionId) {
        where.push("session_id = ?");
        p.push(String(req.query.sessionId));
      }
      if (req.query.library === "1") where.push("in_library = 1");
      const rows = ctx.db.all<Parameters<typeof ctx.storage.toPublic>[0]>(`SELECT * FROM video_assets WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`, ...p);
      return { assets: rows.map((r) => ctx.storage.toPublic(r)) };
    }),
  );

  /** Tải lên video/ảnh tham chiếu (multipart, field "file"; query kind=reference|image, sessionId) */
  app.post(
    "/api/assets",
    h(async (req) => {
      const kindQ = String(req.query.kind ?? "");
      const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
      if (sessionId) sessions.row(ws(req), sessionId);
      const files = await receiveUploads(req, ctx.storage.tmpDir("uploads"));
      if (!files.length) throw new AppError("NO_FILE", "Không nhận được file.", 400);
      const out = [];
      for (const f of files) {
        const mime = mimeOf(f.fileName);
        if (!mime) {
          fs.rmSync(f.tmpPath, { force: true });
          throw new AppError("UNSUPPORTED_FILE", `Không hỗ trợ file ${f.fileName} (chỉ mp4/mov/webm/mkv, jpg/png/webp).`, 400);
        }
        const kind = mime.startsWith("image/") ? "image" : kindQ === "generated" ? "generated" : "reference";
        const row = await ctx.storage.ingestFile({ workspaceId: ws(req), sessionId, tmpPath: f.tmpPath, fileName: f.fileName, kind, origin: "upload", createdBy: req.principal!.user.id, folder: "uploads" });
        out.push(ctx.storage.toPublic(row));
      }
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "asset.upload", data: { count: out.length } });
      return { assets: out };
    }),
  );

  app.get("/api/assets/:id", h((req) => ctx.storage.toPublic(ctx.storage.getRow(ws(req), String(req.params.id)))));

  const serveAsset = (variant: "file" | "preview" | "thumbnail") =>
    h((req, res) => {
      const a = ctx.storage.getRow(ws(req), String(req.params.id));
      const rel = variant === "thumbnail" ? a.thumbnail_path : variant === "preview" ? (a.preview_path ?? a.storage_path) : a.storage_path;
      if (!rel) throw new AppError("NOT_FOUND", "Không có file.", 404);
      const file = ctx.storage.abs(rel);
      if (!fs.existsSync(file)) throw new AppError("NOT_FOUND", "File đã mất khỏi kho.", 404);
      const mime = variant === "thumbnail" ? "image/jpeg" : variant === "preview" && a.preview_path ? "video/mp4" : a.mime;
      if (variant === "file" && req.query.download === "1") {
        audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "asset.download", targetType: "asset", targetId: a.id });
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
      }
      sendRange(req, res, file, mime);
    });
  app.get("/api/assets/:id/file", serveAsset("file"));
  app.get("/api/assets/:id/preview", serveAsset("preview"));
  app.get("/api/assets/:id/thumbnail", serveAsset("thumbnail"));
  app.post(
    "/api/assets/library",
    h((req) => {
      const ids: string[] = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      const n = ctx.storage.setInLibrary(ws(req), ids, req.body?.inLibrary !== false);
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "library.update", data: { count: n, inLibrary: req.body?.inLibrary !== false } });
      return { updated: n };
    }),
  );
  /** Ghép nhiều video (theo thứ tự assetIds) thành 1 video hoàn chỉnh */
  app.post(
    "/api/assets/merge",
    h(async (req) => {
      const ids: string[] = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      const row = await mergeVideos(ctx, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, sessionId: req.body?.sessionId ?? null, assetIds: ids, name: req.body?.name });
      return ctx.storage.toPublic(row);
    }),
  );
  /** AI (model chữ trong Cài đặt LLM) tự dựng: sắp thứ tự, cắt, chuyển cảnh, chèn chữ -> 1 video */
  app.post(
    "/api/assets/auto-edit",
    h(async (req) => {
      const ids: string[] = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      const r = await renderEdit(ctx, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, assetIds: ids, brief: req.body?.brief, name: req.body?.name });
      return { asset: ctx.storage.toPublic(r.asset), plan: r.plan };
    }),
  );
  /** Dựng nâng cao bằng Claude Code + skill HyperFrames (chạy nền, hỏi trạng thái bằng GET) */
  app.post(
    "/api/assets/pro-edit",
    h((req) => {
      const ids: string[] = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      return startProEdit(ctx, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, assetIds: ids, brief: req.body?.brief, name: req.body?.name });
    }),
  );
  app.get("/api/assets/pro-edit/:id", h((req) => getProEdit(ws(req), String(req.params.id))));
  app.post("/api/assets/:id/send-to-edit", h((req) => exporter.sendToEdit(ws(req), String(req.params.id))));
  /** Xóa HẲN nhiều video/ảnh (file + DB). Body: { assetIds: [...] } */
  app.post(
    "/api/assets/delete",
    h((req) => {
      const ids: string[] = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      if (!ids.length) throw new AppError("NO_ASSETS", "Chưa chọn video nào để xóa.", 400);
      const r = ctx.storage.deleteAssets(ws(req), ids, { skipInUse: true });
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "asset.delete", targetType: "assets", targetId: r.deleted.join(","), data: { deleted: r.deleted.length, skipped: r.skipped.length, freedBytes: r.freedBytes } });
      if (r.deleted.length) recordEvent(ctx.db, { workspaceId: ws(req), type: "asset.deleted", message: `Đã xóa ${r.deleted.length} video.` });
      return { deleted: r.deleted, skipped: r.skipped, freedBytes: r.freedBytes };
    }),
  );
  app.delete(
    "/api/assets/:id",
    h((req) => {
      const r = ctx.storage.deleteAssets(ws(req), [String(req.params.id)]);
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "asset.delete", targetType: "asset", targetId: String(req.params.id), data: { freedBytes: r.freedBytes } });
      recordEvent(ctx.db, { workspaceId: ws(req), type: "asset.deleted", message: "Đã xóa 1 video." });
      return { deleted: r.deleted, freedBytes: r.freedBytes };
    }),
  );
  /** Dọn thư mục asset mồ côi trên đĩa (không còn trong DB) */
  app.post(
    "/api/assets/prune-orphans",
    h((req) => {
      const r = ctx.storage.pruneOrphanDirs(ws(req));
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "asset.prune_orphans", data: r });
      return r;
    }),
  );
  app.post(
    "/api/assets/zip",
    h(async (req, res) => {
      const ids: string[] = Array.isArray(req.body?.assetIds) ? req.body.assetIds.map(String) : [];
      if (!ids.length) throw new AppError("NO_ASSETS", "Chưa chọn video nào.", 400);
      for (const id of ids) ctx.storage.getRow(ws(req), id); // kiểm quyền trước khi stream
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="videos-${Date.now()}.zip"`);
      await exporter.zipAssets(ws(req), ids, res);
      audit(ctx.db, { workspaceId: ws(req), userId: req.principal!.user.id, actor: actorOf(req).kind, action: "library.zip", data: { count: ids.length } });
    }),
  );

  // ------------------------------------------------------------ prompt

  app.post(
    "/api/prompts/parse",
    h((req) => {
      const text = String(req.body?.text ?? "");
      const fmt = (req.body?.format as "txt" | "csv" | "json") || detectFormat(req.body?.fileName, text);
      const parsed = parsePrompts(text, fmt);
      const list = checkList(parsed.items, parsed.blankLines);
      return { ...parsed, check: list, summary: `${list.uniqueLines.length} dòng hợp lệ → ${list.uniqueLines.length} video` };
    }),
  );
  app.post(
    "/api/prompts/check",
    h((req) => {
      const b = req.body ?? {};
      return batches.check(ws(req), { providerConfigId: String(b.providerConfigId), modelId: String(b.modelId), config: { ...defaultCfg(b.config) }, prompts: (b.prompts ?? []) as BatchPromptInput[], blankLines: b.blankLines, lines: b.lines });
    }),
  );
  app.get("/api/prompt-sets", h((req) => ({ sets: prompts.listSets(ws(req), (req.query.sessionId as string) || null) })));
  app.post(
    "/api/prompt-sets",
    h((req) => {
      const b = req.body ?? {};
      let items = b.items;
      if (!items && typeof b.text === "string") items = parsePrompts(b.text, detectFormat(b.fileName, b.text)).items.map((i) => i.draft);
      if (!Array.isArray(items) || !items.length) throw new AppError("NO_PROMPTS", "Chưa có prompt.", 400);
      return prompts.createSet(ws(req), actorOf(req), { sessionId: b.sessionId ?? null, name: String(b.name ?? "Bộ prompt"), source: b.text ? "import" : "manual", items });
    }),
  );
  app.post(
    "/api/prompt-sets/generate",
    h(async (req) => {
      const b = req.body ?? {};
      return prompts.generate(ws(req), actorOf(req), {
        sessionId: b.sessionId ?? null,
        count: Number(b.count),
        durationSec: Number(b.durationSec),
        aspectRatio: String(b.aspectRatio),
        providerConfigId: String(b.providerConfigId),
        modelId: String(b.modelId),
        genres: b.genres,
        brief: b.brief,
        consistency: b.consistency,
        referenceAssetIds: b.referenceAssetIds,
        language: b.language,
        name: b.name,
      });
    }),
  );
  app.get("/api/prompt-sets/:id", h((req) => prompts.getSet(ws(req), String(req.params.id))));
  /** Triển khai bộ prompt → batch (mỗi prompt = 1 video). dryRun=true chỉ kiểm + ước tính; run.confirm=true duyệt chạy luôn. */
  app.post(
    "/api/prompt-sets/:id/deploy",
    h((req) => {
      const b = req.body ?? {};
      const sel = ["auto", "approved", "all"].includes(b.selection) ? (b.selection as DeploySelection) : "auto";
      const run = b.run && typeof b.run === "object" ? { confirm: b.run.confirm === true, approvedMaxCost: num(b.run.approvedMaxCost) ?? null, acknowledgeUnknownCost: b.run.acknowledgeUnknownCost === true } : null;
      return deployer.deploy(ws(req), actorOf(req), String(req.params.id), {
        sessionId: b.sessionId === undefined ? undefined : (b.sessionId ?? null),
        providerConfigId: b.providerConfigId ? String(b.providerConfigId) : null,
        modelId: b.modelId ? String(b.modelId) : null,
        config: b.config ?? {},
        selection: sel,
        useItemOverrides: b.useItemOverrides !== false,
        defaultNegative: typeof b.defaultNegative === "string" ? b.defaultNegative : null,
        maxConcurrency: num(b.maxConcurrency),
        budgetLimit: num(b.budgetLimit) ?? null,
        name: typeof b.name === "string" ? b.name : undefined,
        dryRun: b.dryRun === true,
        run,
      });
    }),
  );
  app.post("/api/prompt-sets/:id/items", h((req) => prompts.addItems(ws(req), String(req.params.id), req.body?.items ?? [])));
  app.post("/api/prompt-sets/:id/approval", h((req) => ({ updated: prompts.setApproval(ws(req), String(req.params.id), req.body?.itemIds ?? "all", req.body?.approval ?? "approved") })));
  // Dọn negative prompt cả bộ - cho model không nhận negative (vd Muse qua muse2api)
  app.post("/api/prompt-sets/:id/clear-negatives", h((req) => ({ cleared: prompts.clearNegatives(ws(req), String(req.params.id)) })));
  app.get(
    "/api/prompt-sets/:id/export",
    h((req, res) => {
      const fmt = (String(req.query.format ?? "txt") as "txt" | "csv" | "json");
      if (!["txt", "csv", "json"].includes(fmt)) throw new AppError("INVALID_FORMAT", "format phải là txt | csv | json", 400);
      const out = prompts.exportSet(ws(req), String(req.params.id), fmt, req.query.onlyApproved === "1");
      res.setHeader("Content-Type", out.mime);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
      res.send(out.body);
    }),
  );
  app.patch("/api/prompt-items/:id", h((req) => prompts.updateItem(ws(req), String(req.params.id), req.body ?? {})));
  app.delete(
    "/api/prompt-items/:id",
    h((req) => {
      prompts.deleteItem(ws(req), String(req.params.id));
      return { ok: true };
    }),
  );
  app.post("/api/prompt-items/:id/duplicate", h((req) => prompts.duplicateItem(ws(req), String(req.params.id))));
  app.post("/api/prompt-items/:id/rewrite", h(async (req) => prompts.rewrite(ws(req), String(req.params.id), String(req.body?.instruction ?? "Viết lại hay hơn, khác biệt hơn"), String(req.body?.providerConfigId), String(req.body?.modelId))));

  // ------------------------------------------------------------ batch

  app.post(
    "/api/batches/estimate",
    h((req) => {
      const b = req.body ?? {};
      const config = defaultCfg(b.config);
      const args = { providerConfigId: String(b.providerConfigId), modelId: String(b.modelId), config, prompts: (b.prompts ?? []) as BatchPromptInput[] };
      const check = batches.check(ws(req), { ...args, blankLines: b.blankLines, lines: b.lines });
      const estimate = batches.estimate(ws(req), { ...args, maxConcurrency: Number(b.maxConcurrency ?? 2), budgetLimit: num(b.budgetLimit) ?? null });
      return { check, estimate };
    }),
  );
  app.get("/api/batches", h((req) => ({ batches: batches.listBatches(ws(req), { sessionId: (req.query.sessionId as string) || null }) })));
  app.post(
    "/api/batches",
    h((req) => {
      const b = req.body ?? {};
      const r = batches.createBatch(ws(req), actorOf(req), {
        sessionId: b.sessionId ?? null,
        name: b.name,
        mode: b.mode ?? "list",
        promptSetId: b.promptSetId ?? null,
        providerConfigId: String(b.providerConfigId),
        modelId: String(b.modelId),
        config: b.config ?? {},
        prompts: b.prompts ?? [],
        blankLines: b.blankLines,
        lines: b.lines,
        maxConcurrency: num(b.maxConcurrency),
        budgetLimit: num(b.budgetLimit) ?? null,
      });
      return { batch: batches.batchToPublic(r.batch), check: r.check, estimate: r.estimate };
    }),
  );
  app.get("/api/batches/:id", h((req) => batches.batchToPublic(batches.getBatchRow(ws(req), String(req.params.id)))));
  app.post(
    "/api/batches/:id/approve",
    h((req) => {
      const b = req.body ?? {};
      return batches.batchToPublic(batches.approveBatch(ws(req), actorOf(req), String(req.params.id), { confirm: b.confirm === true, approvedMaxCost: num(b.approvedMaxCost) ?? null, acknowledgeUnknownCost: b.acknowledgeUnknownCost === true }));
    }),
  );
  app.post("/api/batches/:id/concurrency", h((req) => batches.batchToPublic(batches.setMaxConcurrency(ws(req), actorOf(req), String(req.params.id), Number(req.body?.maxConcurrency)))));
  app.post("/api/batches/:id/pause", h((req) => batches.batchToPublic(batches.setBatchStatus(ws(req), actorOf(req), String(req.params.id), "pause"))));
  app.post("/api/batches/:id/resume", h((req) => batches.batchToPublic(batches.setBatchStatus(ws(req), actorOf(req), String(req.params.id), "resume"))));
  app.post("/api/batches/:id/cancel-pending", h((req) => ({ cancelled: batches.cancelPending(ws(req), actorOf(req), String(req.params.id)) })));
  app.post(
    "/api/batches/:id/retry-failed",
    h((req) => batches.retryJobs(ws(req), actorOf(req), { batchId: String(req.params.id), confirm: req.body?.confirm === true, approvedMaxCost: num(req.body?.approvedMaxCost) ?? null, acknowledgeUnknownCost: req.body?.acknowledgeUnknownCost === true })),
  );
  app.get("/api/batches/:id/events", h((req) => ({ events: batches.events(ws(req), { batchId: String(req.params.id), limit: 300 }) })));
  /** Xóa HẲN batch (+ video của batch, trừ khi keepAssets=1) */
  app.delete(
    "/api/batches/:id",
    h((req) => batches.deleteBatch(ws(req), actorOf(req), String(req.params.id), { keepAssets: req.query.keepAssets === "1" })),
  );

  app.get(
    "/api/batches/:id/export",
    h(async (req, res) => {
      const fmt = String(req.query.format ?? "zip");
      const id = String(req.params.id);
      batches.getBatchRow(ws(req), id);
      if (fmt === "zip") {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="batch-${id}.zip"`);
        await exporter.zipBatch(ws(req), id, res, { userId: req.principal!.user.id, kind: actorOf(req).kind });
        return;
      }
      if (!["csv", "json", "txt"].includes(fmt)) throw new AppError("INVALID_FORMAT", "format phải là zip | csv | json | txt", 400);
      const out = exporter.exportText(ws(req), id, fmt as "csv" | "json" | "txt");
      res.setHeader("Content-Type", out.mime);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
      res.send(out.body);
    }),
  );

  // ------------------------------------------------------------ job

  app.get(
    "/api/jobs",
    h((req) => {
      const statuses = req.query.status ? String(req.query.status).split(",").filter(Boolean) : undefined;
      return batches.listJobs(ws(req), { batchId: req.query.batchId as string | undefined, sessionId: req.query.sessionId as string | undefined, statuses, q: req.query.q as string | undefined, limit: num(req.query.limit), offset: num(req.query.offset) });
    }),
  );
  app.get("/api/jobs/:id", h((req) => batches.jobToPublic(batches.getJobRow(ws(req), String(req.params.id)))));
  app.get("/api/jobs/:id/versions", h((req) => ({ versions: batches.versions(ws(req), String(req.params.id)) })));
  app.get("/api/jobs/:id/events", h((req) => ({ events: batches.events(ws(req), { jobId: String(req.params.id), limit: 200 }) })));
  app.post(
    "/api/jobs/:id/cancel",
    h(async (req) => {
      const r = await batches.cancelJob(ws(req), actorOf(req), String(req.params.id));
      return { job: batches.jobToPublic(r.job), cancelled: r.cancelled, message: r.message };
    }),
  );
  app.post(
    "/api/jobs/retry",
    h((req) => batches.retryJobs(ws(req), actorOf(req), { jobIds: (req.body?.jobIds ?? []).map(String), confirm: req.body?.confirm === true, approvedMaxCost: num(req.body?.approvedMaxCost) ?? null, acknowledgeUnknownCost: req.body?.acknowledgeUnknownCost === true })),
  );
  app.post(
    "/api/jobs/approve",
    h((req) => ({ approved: batches.approveJobs(ws(req), actorOf(req), (req.body?.jobIds ?? []).map(String), { confirm: req.body?.confirm === true, approvedMaxCost: num(req.body?.approvedMaxCost) ?? null, acknowledgeUnknownCost: req.body?.acknowledgeUnknownCost === true }) })),
  );
  app.post(
    "/api/jobs/:id/regenerate",
    h((req) => {
      const b = req.body ?? {};
      return batches.jobToPublic(
        batches.regenerate(ws(req), actorOf(req), String(req.params.id), {
          prompt: b.prompt,
          negative: b.negative,
          durationSec: num(b.durationSec),
          aspectRatio: b.aspectRatio,
          confirm: b.confirm === true,
          approvedMaxCost: num(b.approvedMaxCost) ?? null,
          acknowledgeUnknownCost: b.acknowledgeUnknownCost === true,
        }),
      );
    }),
  );

  // ------------------------------------------------------------ thư viện, audit, tool

  app.get(
    "/api/library",
    h((req) => {
      const rows = ctx.db.all<Parameters<typeof ctx.storage.toPublic>[0] & { batch_id: string | null; batch_name: string | null; session_title: string | null; version: number | null; prompt: string | null }>(
        `SELECT a.*, j.batch_id, b.name AS batch_name, s.title AS session_title, j.version, j.prompt FROM video_assets a
         LEFT JOIN video_batch_jobs j ON j.id = a.source_job_id LEFT JOIN video_batches b ON b.id = j.batch_id LEFT JOIN studio_sessions s ON s.id = a.session_id
         WHERE a.workspace_id = ? AND a.kind = 'generated' ${req.query.libraryOnly === "1" ? "AND a.in_library = 1" : ""} ORDER BY a.created_at DESC LIMIT 1000`,
        ws(req),
      );
      return { items: rows.map((r) => ({ ...ctx.storage.toPublic(r), batchId: r.batch_id, batchName: r.batch_name, sessionTitle: r.session_title, version: r.version, prompt: r.prompt })) };
    }),
  );
  app.get("/api/audit", h((req) => ({ entries: ctx.db.all("SELECT id, user_id, actor, action, target_type, target_id, data_json, created_at FROM audit_log WHERE workspace_id = ? ORDER BY id DESC LIMIT 300", ws(req)) })));
  app.get("/api/tools", h(() => ({ tools: TOOLS.map((t) => ({ name: t.name, alias: t.alias, description: t.description, inputSchema: toJsonSchema(t.schema) })) })));
  app.post(
    "/api/tools/:name",
    h(async (req) => {
      const channel = req.principal!.via === "api-token" ? "api" : "api";
      return invokeTool(ctx, { workspaceId: ws(req), userId: req.principal!.user.id, channel, sessionId: req.body?.sessionId ?? null }, String(req.params.name), req.body?.args ?? {});
    }),
  );

  // ------------------------------------------------------------ SSE (đuôi bảng job_events)

  app.get("/api/events", (req: AuthedRequest, res) => {
    const workspaceId = ws(req);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let last = Number(req.headers["last-event-id"] ?? req.query.after ?? 0) || Number(ctx.db.get<{ m: number }>("SELECT MAX(id) AS m FROM job_events WHERE workspace_id = ?", workspaceId)?.m ?? 0);
    res.write(`retry: 2000\n\n`);
    let busy = false;
    const flush = () => {
      if (busy) return;
      busy = true;
      try {
        const rows = ctx.db.all<EventRow>("SELECT * FROM job_events WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT 500", workspaceId, last);
        for (const r of rows) {
          last = r.id;
          res.write(`id: ${r.id}\nevent: ${r.type}\ndata: ${JSON.stringify(eventToPublic(r))}\n\n`);
        }
      } finally {
        busy = false;
      }
    };
    const onWake = (w: string) => w === workspaceId && setTimeout(flush, 30);
    wake.on("event", onWake);
    const poll = setInterval(flush, 1000); // thay đổi do worker ở tiến trình khác
    const ping = setInterval(() => res.write(`: ping\n\n`), 20_000);
    req.on("close", () => {
      wake.off("event", onWake);
      clearInterval(poll);
      clearInterval(ping);
    });
  });

  app.use("/api", (_req, _res, next) => next(new AppError("NOT_FOUND", "API không tồn tại.", 404)));

  // ------------------------------------------------------------ web tĩnh (bản build)

  const dist = path.join(ROOT_DIR, "web", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  // ------------------------------------------------------------ lỗi

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details ?? null } });
      return;
    }
    const msg = redact((err as Error)?.message ?? String(err));
    if ((err as { type?: string })?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "BAD_JSON", message: "JSON không hợp lệ." } });
      return;
    }
    console.error("[http] lỗi:", msg);
    res.status(500).json({ error: { code: "INTERNAL", message: "Lỗi máy chủ: " + msg } });
  });

  return app;
}

function defaultCfg(c: Partial<BatchConfig> | undefined): BatchConfig {
  return {
    mode: c?.mode ?? "text-to-video",
    durationSec: Number(c?.durationSec ?? 8),
    aspectRatio: c?.aspectRatio ?? "9:16",
    resolution: c?.resolution ?? "720p",
    audio: Boolean(c?.audio),
    quality: c?.quality ?? null,
    variantsPerPrompt: Math.max(1, Math.min(10, Number(c?.variantsPerPrompt ?? 1))),
    referenceAssetIds: c?.referenceAssetIds ?? [],
    maxAttempts: Math.max(1, Math.min(6, Number(c?.maxAttempts ?? 3))),
  };
}

function setSessionCookie(res: Response, token: string, expiresAt: string): void {
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}`);
}

/** Phục vụ file có hỗ trợ Range (tua video) */
function sendRange(req: Request, res: Response, file: string, mime: string): void {
  const size = fs.statSync(file).size;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Number(range[2]) : size - 1;
    if (!range[1] && range[2]) {
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    }
    if (start >= size || end >= size || start > end) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.setHeader("Content-Length", String(size));
  fs.createReadStream(file).pipe(res);
}

function receiveUploads(req: Request, tmpDir: string): Promise<{ tmpPath: string; fileName: string }[]> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: 4 * 1024 ** 3, files: 20 }, defParamCharset: "utf8" });
    } catch {
      reject(new AppError("BAD_UPLOAD", "Cần multipart/form-data.", 400));
      return;
    }
    const files: { tmpPath: string; fileName: string }[] = [];
    const writes: Promise<void>[] = [];
    bb.on("file", (_field, stream, info) => {
      const tmpPath = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const ws = fs.createWriteStream(tmpPath);
      writes.push(
        new Promise((ok, bad) => {
          ws.on("finish", () => ok());
          ws.on("error", bad);
          stream.on("limit", () => bad(new AppError("FILE_TOO_LARGE", "File quá lớn (tối đa 4GB).", 413)));
        }),
      );
      stream.pipe(ws);
      files.push({ tmpPath, fileName: info.filename || "upload" });
    });
    bb.on("error", reject);
    bb.on("close", () => {
      Promise.all(writes)
        .then(() => resolve(files))
        .catch((e) => {
          for (const f of files) fs.rmSync(f.tmpPath, { force: true });
          reject(e);
        });
    });
    req.pipe(bb);
  });
}
