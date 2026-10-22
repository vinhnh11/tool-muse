import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEnv, mockProviderId, tmpDir, userClient, type TestEnv } from "./helpers.ts";
import { Db, migrate } from "../src/db.ts";
import { createPage, deletePage, getPagePause, listPages, updatePage } from "../src/fbreels/config.ts";
import { enqueueReel, listQueue, retry } from "../src/fbreels/queue.ts";
import { ReelsPublisher } from "../src/fbreels/publisher.ts";
import { PromptService } from "../src/promptgen.ts";
import { invokeTool } from "../src/tools.ts";
import { newId } from "../src/util.ts";

/** Nhiều Page Facebook: migration, chọn Page khi tạo batch, cách ly giữa các Page, xoá Page. Graph luôn là mock, không đăng thật. */

const TOKEN_A = "EAAB_TOKEN_PAGE_A_1111aaaa";
const TOKEN_B = "EAAB_TOKEN_PAGE_B_2222bbbb";
const PAGE_A = "1000000001";
const PAGE_B = "2000000002";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeGraph() {
  const calls: Call[] = [];
  let vid = 0;
  const f = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init.body;
    calls.push({ url, method: init.method ?? "GET", headers: { ...(init.headers ?? {}) }, body: typeof body === "string" ? body : null });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.includes("rupload.facebook.com")) return json({ success: true });
    if (url.includes("/video_reels")) {
      const b = JSON.parse(body);
      if (b.upload_phase === "start") {
        vid++;
        return json({ video_id: `vid${vid}`, upload_url: `https://rupload.facebook.com/video-upload/v26.0/vid${vid}` });
      }
      return json({ success: true });
    }
    if (url.includes("fields=status")) return json({ status: { video_status: "ready" } });
    const m = /facebook\.com\/v[\d.]+\/(\d+)\?/.exec(url);
    return json({ id: m?.[1] ?? "0", name: `Tên thật ${m?.[1] ?? ""}` });
  }) as typeof fetch;
  return { f, calls };
}

async function setup(name: string, fetchImpl?: typeof fetch) {
  const env = await createEnv(name);
  if (fetchImpl) (env.ctx as any).fetchImpl = fetchImpl;
  const c = await userClient(env, `u_${name}`);
  return { env, c, ws: c.workspaceId };
}

function addVideoFor(env: TestEnv, ws: string, fbPage: string | null): string {
  const id = newId("ast");
  const bid = newId("bat");
  const jid = newId("job");
  const now = new Date().toISOString();
  env.ctx.db.run(
    "INSERT INTO video_batches (id, workspace_id, name, mode, provider_config_id, model_id, config_json, max_concurrency, status, fb_page_id, created_at, updated_at) VALUES (?, ?, 'b', 'single', 'p', 'm', '{}', 1, 'running', ?, ?, ?)",
    bid, ws, fbPage, now, now,
  );
  env.ctx.db.run(
    "INSERT INTO video_batch_jobs (id, batch_id, workspace_id, seq, prompt, provider_config_id, model_id, config_json, status, lineage_id, created_at, updated_at) VALUES (?, ?, ?, 1, 'p', 'p', 'm', '{}', 'running', ?, ?, ?)",
    jid, bid, ws, jid, now, now,
  );
  const rel = `${ws}/${id}.mp4`;
  fs.mkdirSync(path.dirname(env.ctx.storage.abs(rel)), { recursive: true });
  fs.writeFileSync(env.ctx.storage.abs(rel), Buffer.alloc(2048, 7));
  env.ctx.db.run(
    `INSERT INTO video_assets (id, workspace_id, kind, origin, file_name, storage_path, mime, size_bytes, sha256, duration_sec, width, height, source_job_id, created_at)
     VALUES (?, ?, 'generated', 'provider', ?, ?, 'video/mp4', 2048, ?, 8, 1080, 1920, ?, ?)`,
    id, ws, `${id}.mp4`, rel, id, jid, now,
  );
  return id;
}

const postOf = (env: TestEnv, assetId: string) => env.ctx.db.get<any>("SELECT * FROM fb_reel_posts WHERE asset_id = ?", assetId);
const pub = (env: TestEnv, t: () => number) => new ReelsPublisher(env.ctx, { now: t, sleep: async () => {}, log: () => {}, pollEveryMs: 1 });
const uploads = (calls: Call[]) => calls.filter((x) => x.url.includes("rupload"));

describe("migration v3: cấu hình một-Page cũ -> Page đầu tiên", () => {
  test("giữ nguyên ciphertext token, chuyển công tắc/hashtag/hàng đợi, idempotent", async () => {
    const env = await createEnv("mig");
    try {
      const dir = tmpDir("mig-db");
      const db = new Db(dir, "old.db", 2); // DB ở phiên bản 2 (trước khi có nhiều Page)
      assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'fb_pages'"), undefined);
      const TOK = "EAAB_LEGACY_TOKEN_9999zzzz";
      const enc = env.ctx.secrets.encrypt(TOK);
      const now = new Date().toISOString();
      db.run("INSERT INTO settings (workspace_id, key, value_json, secret_enc, updated_at) VALUES ('w1', 'facebook_reels', ?, ?, ?)", JSON.stringify({ pageId: "777000111", graphVersion: "v25.0", intervalMin: 30, autoEnabled: true, requireApproval: false, captionTemplate: "{tieu_de}", hashtags: "#cu #moi", aiCaption: true, enabledSince: "2026-01-01T00:00:00.000Z", tokenLast4: "zzzz" }), enc, now);
      db.run("INSERT INTO settings (workspace_id, key, value_json, secret_enc, updated_at) VALUES ('w1', 'facebook_reels_state', ?, NULL, ?)", JSON.stringify({ lastPublishAt: 1700000000000 }), now);
      // workspace dở dang: có pageId nhưng không có token -> không tạo Page
      db.run("INSERT INTO settings (workspace_id, key, value_json, secret_enc, updated_at) VALUES ('w2', 'facebook_reels', ?, NULL, ?)", JSON.stringify({ pageId: "555000111", autoEnabled: false }), now);
      db.raw.exec("PRAGMA foreign_keys = OFF");
      db.run("INSERT INTO fb_reel_posts (id, workspace_id, asset_id, status, created_at, updated_at) VALUES ('old1', 'w1', 'astX', 'published', ?, ?)", now, now);
      db.run("INSERT INTO video_batches (id, workspace_id, name, mode, provider_config_id, model_id, config_json, max_concurrency, status, created_at, updated_at) VALUES ('bt1', 'w1', 'b', 'single', 'p', 'm', '{}', 1, 'completed', ?, ?)", now, now);

      migrate(db);
      migrate(db); // chạy lần 2: không nhân đôi
      const pages = db.all<any>("SELECT * FROM fb_pages");
      assert.equal(pages.length, 1);
      const p = pages[0];
      assert.equal(p.workspace_id, "w1");
      assert.equal(p.page_id, "777000111");
      assert.equal(p.token_enc, enc, "ciphertext chép nguyên");
      assert.equal(env.ctx.secrets.decrypt(p.token_enc), TOK, "giải mã ra đúng token cũ");
      assert.equal(p.token_last4, "zzzz");
      assert.equal(p.auto_enabled, 1);
      assert.equal(p.interval_min, 30);
      assert.equal(p.require_approval, 0);
      assert.equal(p.hashtags, "#cu #moi");
      assert.equal(p.last_publish_at, 1700000000000);
      assert.equal(db.get<any>("SELECT fb_page_id FROM fb_reel_posts WHERE id = 'old1'")!.fb_page_id, p.id);
      assert.equal(db.get<any>("SELECT fb_page_id FROM video_batches WHERE id = 'bt1'")!.fb_page_id, p.id);
      // dữ liệu cũ vẫn còn để rollback
      assert.equal(db.get<any>("SELECT secret_enc FROM settings WHERE workspace_id = 'w1' AND key = 'facebook_reels'")!.secret_enc, enc);
      assert.equal(db.all("SELECT 1 FROM schema_migrations WHERE version = 3").length, 1);
      db.close();
    } finally {
      await env.close();
    }
  });
});

const body = (extra: Record<string, unknown> = {}, prov = "") => ({ mode: "list", providerConfigId: prov, modelId: "mock-standard", config: { durationSec: 4, aspectRatio: "9:16", resolution: "480p", audio: false }, prompts: [{ prompt: "một cảnh thử" }], ...extra });

describe("chọn Page khi tạo batch (luật ở server)", () => {
  test("0 Page: tạo được không cần fbPage; có Page: thiếu -> FB_PAGE_REQUIRED tiếng Việt; sai -> FB_PAGE_INVALID; none -> hợp lệ", async () => {
    const { env, c, ws } = await setup("sel");
    try {
      const prov = mockProviderId(env, ws);
      const r0 = await c.post("/api/batches", body({}, prov));
      assert.equal(r0.status, 200, JSON.stringify(r0.body));
      assert.equal(r0.body.batch.fbPage, null);

      const pa = createPage(env.ctx, ws, { pageId: PAGE_A, pageToken: TOKEN_A, name: "Trang A", autoEnabled: true });
      const r1 = await c.post("/api/batches", body({}, prov));
      assert.equal(r1.status, 400);
      assert.equal(r1.body.error?.code ?? r1.body.code, "FB_PAGE_REQUIRED");
      assert.match(JSON.stringify(r1.body), /phải chọn Page/);
      assert.match(JSON.stringify(r1.body), /Trang A/);
      assert.equal((await c.post("/api/batches", body({ fbPage: "" }, prov))).status, 400);
      const r2 = await c.post("/api/batches", body({ fbPage: "fbp_khongco" }, prov));
      assert.equal(r2.status, 400);
      assert.match(JSON.stringify(r2.body), /FB_PAGE_INVALID/);
      const rn = await c.post("/api/batches", body({ fbPage: "none" }, prov));
      assert.equal(rn.status, 200);
      assert.equal(rn.body.batch.fbPage, "none");
      const ra = await c.post("/api/batches", body({ fbPage: pa.id }, prov));
      assert.equal(ra.status, 200);
      assert.deepEqual(ra.body.batch.fbPage, { id: pa.id, name: "Trang A" });
      // không có batch nào được tạo cho các lần bị từ chối
      assert.equal(Number(env.ctx.db.get<any>("SELECT COUNT(*) n FROM video_batches WHERE workspace_id = ?", ws).n), 3);
    } finally {
      await env.close();
    }
  });

  test("Page của workspace khác bị từ chối", async () => {
    const { env, c, ws } = await setup("sel_ws");
    try {
      const other = await userClient(env, "u_other_ws");
      const po = createPage(env.ctx, other.workspaceId, { pageId: PAGE_B, pageToken: TOKEN_B });
      createPage(env.ctx, ws, { pageId: PAGE_A, pageToken: TOKEN_A });
      const r = await c.post("/api/batches", body({ fbPage: po.id }, mockProviderId(env, ws)));
      assert.equal(r.status, 400);
      assert.match(JSON.stringify(r.body), /FB_PAGE_INVALID/);
    } finally {
      await env.close();
    }
  });

  test("tool video_create_batch / video_deploy_prompt_set / video_list_fb_pages", async () => {
    const { env, c, ws } = await setup("sel_tool");
    try {
      const userId = env.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'u_sel_tool'")!.id;
      const call = { workspaceId: ws, userId, channel: "mcp" as const };
      const prov = mockProviderId(env, ws);
      const list0: any = await invokeTool(env.ctx, call, "video_list_fb_pages", {});
      assert.equal(list0.required, false);
      const pg = createPage(env.ctx, ws, { pageId: PAGE_A, pageToken: TOKEN_A, name: "Trang A" });
      const list1: any = await invokeTool(env.ctx, call, "video_list_fb_pages", {});
      assert.equal(list1.required, true);
      assert.equal(list1.pages[0].id, pg.id);
      assert.ok(!JSON.stringify(list1).includes(TOKEN_A));
      const args = { prompts: ["một cảnh thử"], providerConfigId: prov, modelId: "mock-standard", config: { durationSec: 4, aspectRatio: "9:16", resolution: "480p", audio: false } };
      await assert.rejects(invokeTool(env.ctx, call, "video_create_batch", args), (e: any) => e.code === "FB_PAGE_REQUIRED" && /phải chọn Page/.test(e.message));
      const ok: any = await invokeTool(env.ctx, call, "video_create_batch", { ...args, fbPage: "none" });
      assert.ok(ok.batchId);
      // deploy
      const ps = new PromptService(env.ctx);
      const set = ps.createSet(ws, { userId, kind: "ui" }, { name: "bộ", source: "ai", params: { providerConfigId: prov, modelId: "mock-standard", durationSec: 4, aspectRatio: "9:16" }, items: [{ title: "a", prompt: "cảnh số một thử nghiệm", durationSec: 4, aspectRatio: "9:16" }] });
      const before = Number(env.ctx.db.get<any>("SELECT COUNT(*) n FROM video_batches").n);
      await assert.rejects(invokeTool(env.ctx, call, "video_deploy_prompt_set", { promptSetId: set.id }), (e: any) => e.code === "FB_PAGE_REQUIRED");
      assert.equal(Number(env.ctx.db.get<any>("SELECT COUNT(*) n FROM video_batches").n), before, "không tạo batch khi thiếu Page");
      const dry: any = await invokeTool(env.ctx, call, "video_deploy_prompt_set", { promptSetId: set.id, dryRun: true });
      assert.equal(dry.dryRun, true, "dryRun không ép chọn Page");
      const dep = await c.post(`/api/prompt-sets/${set.id}/deploy`, {});
      assert.equal(dep.status, 400);
      assert.match(JSON.stringify(dep.body), /FB_PAGE_REQUIRED/);
      const dep2 = await c.post(`/api/prompt-sets/${set.id}/deploy`, { fbPage: pg.id });
      assert.equal(dep2.status, 200, JSON.stringify(dep2.body));
      assert.equal(dep2.body.batch.fbPage.id, pg.id);
    } finally {
      await env.close();
    }
  });
});

describe("cách ly giữa hai Page", () => {
  test("batch chọn A: mọi mục queue mang pageId A; publish chỉ gọi Graph bằng ID + token của A; none không vào hàng", async () => {
    const g = fakeGraph();
    const { env, ws } = await setup("iso", g.f);
    try {
      const a = createPage(env.ctx, ws, { pageId: PAGE_A, pageToken: TOKEN_A, autoEnabled: true, requireApproval: false, intervalMin: 5 });
      const b = createPage(env.ctx, ws, { pageId: PAGE_B, pageToken: TOKEN_B, autoEnabled: true, requireApproval: false, intervalMin: 5 });
      const v1 = addVideoFor(env, ws, a.id);
      const v2 = addVideoFor(env, ws, a.id);
      const vNone = addVideoFor(env, ws, "none");
      const vNull = addVideoFor(env, ws, null);
      for (const v of [v1, v2, vNone, vNull]) enqueueReel(env.ctx, v);
      assert.equal(postOf(env, v1).fb_page_id, a.id);
      assert.equal(postOf(env, v2).fb_page_id, a.id);
      assert.equal(postOf(env, vNone), undefined, "none không tạo mục hàng đợi");
      assert.equal(postOf(env, vNull), undefined);
      let t = 1_700_000_000_000;
      const p = pub(env, () => t);
      await p.tickOnce();
      t += 10 * 60_000;
      await p.tickOnce();
      assert.equal(uploads(g.calls).length, 2);
      for (const call of g.calls) {
        assert.ok(!call.url.includes(PAGE_B), call.url);
        assert.ok(!JSON.stringify(call.headers).includes(TOKEN_B) && !(call.body ?? "").includes(TOKEN_B));
      }
      const starts = g.calls.filter((x) => x.url.includes("/video_reels") && JSON.parse(x.body!).upload_phase === "start");
      assert.equal(starts.length, 2);
      for (const s of starts) {
        assert.ok(s.url.includes(`/${PAGE_A}/video_reels`));
        assert.equal(JSON.parse(s.body!).access_token, TOKEN_A);
      }
      for (const u of uploads(g.calls)) assert.equal(u.headers.Authorization, `OAuth ${TOKEN_A}`);
      assert.equal(env.ctx.db.all("SELECT 1 FROM fb_reel_posts WHERE fb_page_id = ?", b.id).length, 0);
    } finally {
      await env.close();
    }
  });

  test("khoảng cách / công tắc / không cần duyệt độc lập; lỗi token A không dừng B", async () => {
    const g = fakeGraph();
    const authFail = (async (input: any, init: any = {}) => {
      if (String(input).includes(`/${PAGE_A}/video_reels`)) return new Response(JSON.stringify({ error: { message: `bad ${TOKEN_A}`, code: 190, type: "OAuthException" } }), { status: 400 });
      return g.f(input, init);
    }) as typeof fetch;
    const { env, c, ws } = await setup("indep", authFail);
    try {
      const a = createPage(env.ctx, ws, { pageId: PAGE_A, pageToken: TOKEN_A, autoEnabled: true, requireApproval: false, intervalMin: 5 });
      const b = createPage(env.ctx, ws, { pageId: PAGE_B, pageToken: TOKEN_B, autoEnabled: true, requireApproval: true, intervalMin: 120 });
      const off = createPage(env.ctx, ws, { pageId: "3000000003", pageToken: "EAAB_TOKEN_C_3333cccc", autoEnabled: false, requireApproval: false });
      const va = addVideoFor(env, ws, a.id);
      const vb1 = addVideoFor(env, ws, b.id);
      const vb2 = addVideoFor(env, ws, b.id);
      const vo = addVideoFor(env, ws, off.id);
      for (const v of [va, vb1, vb2, vo]) enqueueReel(env.ctx, v);
      assert.equal(postOf(env, va).status, "approved", "A không cần duyệt");
      assert.equal(postOf(env, vb1).status, "pending_review", "B cần duyệt");
      assert.equal(postOf(env, vo), undefined, "Page tắt tự đăng không xếp hàng");
      let t = 1_700_000_000_000;
      const p = pub(env, () => t);
      env.ctx.db.run("UPDATE fb_reel_posts SET status = 'approved' WHERE fb_page_id = ?", b.id);
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...x) => logs.push(x.join(" "));
      try {
        await p.tickOnce();
      } finally {
        console.log = orig;
      }
      assert.equal(getPagePause(env.ctx, a.id)?.kind, "token", "A bị tạm dừng");
      assert.equal(getPagePause(env.ctx, b.id), null, "B không bị ảnh hưởng");
      assert.equal(postOf(env, vb1).status, "published", "B vẫn đăng");
      assert.equal(postOf(env, va).status, "approved", "A về hàng đợi");
      assert.ok(!logs.join("\n").includes(TOKEN_A));
      // B còn chờ khoảng cách 120', A đang pause: không ai đăng
      t += 60 * 60_000;
      await p.tickOnce();
      assert.equal(postOf(env, vb2).status, "approved");
      t += 61 * 60_000;
      await p.tickOnce();
      assert.equal(postOf(env, vb2).status, "published", "đủ 120' của B");
      // API: pause theo Page, không lộ token, resume riêng
      const q = (await c.get("/api/facebook/reels/queue")).body;
      assert.deepEqual(Object.keys(q.pauses), [a.id]);
      assert.ok(!JSON.stringify(q).includes(TOKEN_A));
      assert.ok(q.items.every((i: any) => i.pageName !== undefined));
      assert.equal((await c.get(`/api/facebook/reels/queue?pageId=${b.id}`)).body.items.length, 2);
      assert.equal((await c.post(`/api/facebook/pages/${a.id}/resume`)).status, 200);
      assert.deepEqual((await c.get("/api/facebook/reels/queue")).body.pauses, {});
    } finally {
      await env.close();
    }
  });

  test("API Page: không lộ token ở response/log/audit; tên tự lấy; sửa tên không bị ghi đè; test kết nối chỉ GET", async () => {
    const g = fakeGraph();
    const { env, c, ws } = await setup("api", g.f);
    try {
      const logs: string[] = [];
      const orig = console.log;
      const origE = console.error;
      const origW = console.warn;
      console.log = console.error = console.warn = (...x) => void logs.push(x.join(" "));
      let raws: string[] = [];
      let a: any;
      try {
        const r1 = await c.post("/api/facebook/pages", { pageId: PAGE_A, pageToken: TOKEN_A });
        a = r1.body;
        raws.push(r1.raw.toString());
        raws.push((await c.post("/api/facebook/pages", { pageId: PAGE_A, pageToken: TOKEN_A })).raw.toString()); // trùng -> 409
        raws.push((await c.req("PUT", `/api/facebook/pages/${a.id}`, { hashtags: "#x" })).raw.toString());
        raws.push((await c.post(`/api/facebook/pages/${a.id}/test`)).raw.toString());
        raws.push((await c.get("/api/facebook/pages")).raw.toString());
        raws.push((await c.get("/api/facebook/reels/queue")).raw.toString());
      } finally {
        console.log = orig;
        console.error = origE;
        console.warn = origW;
      }
      for (const r of raws) assert.ok(!r.includes(TOKEN_A));
      assert.ok(!logs.join("\n").includes(TOKEN_A));
      assert.ok(!JSON.stringify(env.ctx.db.all("SELECT * FROM audit_log")).includes(TOKEN_A));
      assert.equal(a.tokenLast4, TOKEN_A.slice(-4));
      assert.equal(listPages(env.ctx, ws)[0]!.name, `Tên thật ${PAGE_A}`);
      assert.ok(g.calls.length > 0 && g.calls.every((x) => x.method === "GET"), "Kiểm tra kết nối không có POST");
      // sửa tên -> test kết nối không ghi đè
      assert.equal((await c.req("PUT", `/api/facebook/pages/${a.id}`, { name: "Tên tôi đặt" })).body.name, "Tên tôi đặt");
      await c.post(`/api/facebook/pages/${a.id}/test`);
      assert.equal(listPages(env.ctx, ws)[0]!.name, "Tên tôi đặt");
      updatePage(env.ctx, ws, a.id, { autoEnabled: true });
      assert.equal((await c.req("PUT", `/api/facebook/reels/settings`, { captionTemplate: "{tieu_de}", aiCaption: true })).body.captionTemplate, "{tieu_de}");
    } finally {
      await env.close();
    }
  });
});

describe("xoá Page", () => {
  test("huỷ mục chờ duyệt/đã duyệt, giữ lịch sử, xoá token, không bao giờ đăng nhầm; đang đăng thì từ chối; retry -> 409", async () => {
    const g = fakeGraph();
    const { env, c, ws } = await setup("del", g.f);
    try {
      const a = createPage(env.ctx, ws, { pageId: PAGE_A, pageToken: TOKEN_A, autoEnabled: true, requireApproval: true });
      const b = createPage(env.ctx, ws, { pageId: PAGE_B, pageToken: TOKEN_B, autoEnabled: true, requireApproval: true });
      const v1 = addVideoFor(env, ws, a.id);
      const v2 = addVideoFor(env, ws, a.id);
      const v3 = addVideoFor(env, ws, a.id);
      const v4 = addVideoFor(env, ws, a.id);
      const vb = addVideoFor(env, ws, b.id);
      for (const v of [v1, v2, v3, v4, vb]) enqueueReel(env.ctx, v);
      env.ctx.db.run("UPDATE fb_reel_posts SET status = 'approved' WHERE asset_id = ?", v2);
      env.ctx.db.run("UPDATE fb_reel_posts SET status = 'failed' WHERE asset_id = ?", v3);
      env.ctx.db.run("UPDATE fb_reel_posts SET status = 'publishing', publishing_at = ? WHERE asset_id = ?", new Date().toISOString(), v4);
      const busy = await c.req("DELETE", `/api/facebook/pages/${a.id}`);
      assert.equal(busy.status, 409);
      assert.match(JSON.stringify(busy.body), /đang đăng/);
      assert.equal(postOf(env, v1).status, "pending_review", "từ chối thì không đổi gì");
      env.ctx.db.run("UPDATE fb_reel_posts SET status = 'published' WHERE asset_id = ?", v4);
      const del = await c.req("DELETE", `/api/facebook/pages/${a.id}`);
      assert.equal(del.status, 200);
      assert.equal(del.body.cancelled, 2);
      assert.equal(postOf(env, v1).status, "skipped");
      assert.equal(postOf(env, v2).status, "skipped");
      assert.match(postOf(env, v1).skip_reason, /Page đã bị xoá/);
      assert.equal(postOf(env, v3).status, "failed", "lịch sử giữ nguyên");
      assert.equal(postOf(env, v4).status, "published");
      assert.equal(postOf(env, vb).status, "pending_review", "Page khác không bị đụng");
      assert.equal(env.ctx.db.get<any>("SELECT token_enc FROM fb_pages WHERE id = ?", a.id).token_enc, null);
      assert.equal(listPages(env.ctx, ws).length, 1);
      // tick không gọi Graph cho Page đã xoá
      env.ctx.db.run("UPDATE fb_reel_posts SET status = 'approved' WHERE asset_id = ?", v2); // cố tình ép về approved
      await pub(env, () => 1_700_000_000_000).tickOnce();
      assert.equal(g.calls.length, 0);
      assert.equal(postOf(env, v2).status, "approved");
      // video mới của batch trỏ Page đã xoá không vào hàng
      assert.equal(enqueueReel(env.ctx, addVideoFor(env, ws, a.id)), false);
      // retry mục của Page đã xoá -> 409
      assert.equal((await c.post(`/api/facebook/reels/queue/${postOf(env, v3).id}/retry`)).status, 409);
      assert.throws(() => retry(env.ctx, ws, postOf(env, v3).id, "u"), /đã bị xoá/);
      // lịch sử vẫn hiện tên Page cũ
      const items = listQueue(env.ctx, ws, {}).items;
      assert.ok(items.some((i) => i.pageId === a.id && i.pageName));
      assert.throws(() => deletePage(env.ctx, ws, a.id), /không tồn tại/);
    } finally {
      await env.close();
    }
  });
});
