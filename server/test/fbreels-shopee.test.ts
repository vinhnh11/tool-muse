import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEnv, mockProviderId, tmpDir, userClient, type TestEnv } from "./helpers.ts";
import { Db, migrate } from "../src/db.ts";
import { createPage, saveSharedSettings } from "../src/fbreels/config.ts";
import { composeCaption, SHOPEE_LINE_PREFIX, CAPTION_MAX } from "../src/fbreels/caption.ts";
import { enqueueReel, listQueue, retryComment, setShopeeUrl, approve } from "../src/fbreels/queue.ts";
import { COMMENT_RETRY_DELAYS_MS, ReelsPublisher } from "../src/fbreels/publisher.ts";
import { normalizeShopeeUrl, validateShopeeUrl } from "../src/fbreels/shopee.ts";
import { newId } from "../src/util.ts";

/** Link Shopee: validate, sao chép batch -> bài, caption, bình luận tự động. Facebook luôn là GIẢ, không gọi mạng thật. */

const TOKEN = "EAAB_SHOPEE_TOKEN_1234567890abcd";
const PAGE_A = "1000000001";
const PAGE_B = "2000000002";
const LINK_A = "https://s.shopee.vn/AbCdEf";
const LINK_B = "https://shope.ee/XyZ123";

interface Call {
  url: string;
  method: string;
  body: string | null;
}

/** commentMode: hàng đợi kết quả cho mỗi lần gọi /comments; hết thì ok */
function fakeGraph(commentMode: Array<"ok" | "perm200" | "http403" | "e500" | "timeout"> = []) {
  const calls: Call[] = [];
  let vid = 0;
  let cid = 0;
  const modes = [...commentMode];
  const f = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init.body;
    calls.push({ url, method: init.method ?? "GET", body: typeof body === "string" ? body : null });
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
    if (url.includes("/comments")) {
      const m = modes.shift() ?? "ok";
      if (m === "perm200") return json({ error: { message: "(#200) Permissions error", type: "OAuthException", code: 200 } }, 400);
      if (m === "http403") return new Response("Forbidden", { status: 403 });
      if (m === "e500") return json({ error: { message: "boom", code: 2 } }, 500);
      if (m === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      cid++;
      return json({ id: `c${cid}` });
    }
    if (url.includes("fields=status")) return json({ status: { video_status: "ready" } });
    return json({ id: "0", name: "x" });
  }) as typeof fetch;
  return { f, calls, comments: () => calls.filter((c) => c.url.includes("/comments")), uploads: () => calls.filter((c) => c.url.includes("rupload")) };
}

async function setup(name: string, fetchImpl?: typeof fetch) {
  const env = await createEnv(name);
  if (fetchImpl) (env.ctx as any).fetchImpl = fetchImpl;
  const c = await userClient(env, `u_${name}`);
  return { env, c, ws: c.workspaceId };
}

/** Video thuộc một batch (có thể mang shopee_url) */
function addVideo(env: TestEnv, ws: string, fbPage: string, shopee: string | null): string {
  const id = newId("ast");
  const bid = newId("bat");
  const jid = newId("job");
  const now = new Date().toISOString();
  env.ctx.db.run(
    "INSERT INTO video_batches (id, workspace_id, name, mode, provider_config_id, model_id, config_json, max_concurrency, status, fb_page_id, shopee_url, created_at, updated_at) VALUES (?, ?, 'b', 'single', 'p', 'm', '{}', 1, 'running', ?, ?, ?, ?)",
    bid, ws, fbPage, shopee, now, now,
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

const postOf = (env: TestEnv, assetId: string) => env.ctx.db.get<any>("SELECT * FROM fb_reel_posts WHERE asset_id = ?", assetId)!;
const mkPub = (env: TestEnv, t: () => number) => new ReelsPublisher(env.ctx, { now: t, sleep: async () => {}, log: () => {}, pollEveryMs: 1 });
const mkPage = (env: TestEnv, ws: string, pageId = PAGE_A, extra: Record<string, unknown> = {}) =>
  createPage(env.ctx, ws, { pageId, pageToken: TOKEN, name: `Trang ${pageId}`, autoEnabled: true, requireApproval: false, intervalMin: 5, aiCaption: false, ...extra });

/** Đăng 1 bài tới published rồi trả về (đồng hồ giả) */
async function publishOne(env: TestEnv, ws: string, link: string | null) {
  const pg = mkPage(env, ws);
  const a = addVideo(env, ws, pg.id, link);
  assert.equal(enqueueReel(env.ctx, a), true);
  let t = 1_700_000_000_000;
  const pub = mkPub(env, () => t);
  await pub.tickOnce();
  return {
    a,
    pub,
    pg,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("validateShopeeUrl", () => {
  test("hợp lệ", () => {
    for (const u of ["https://shopee.vn/product/1/2", "https://s.shopee.vn/AbC", "https://shope.ee/x", "https://vn.shp.ee/x", "https://shp.ee/x", "https://shopee.com/x", "https://abc.shopee.vn/x", "  https://shopee.vn/a?b=1  "]) {
      assert.equal(validateShopeeUrl(u).ok, true, u);
    }
    assert.equal((validateShopeeUrl("  https://shopee.vn/a  ") as any).url, "https://shopee.vn/a");
  });
  test("không hợp lệ + thông báo tiếng Việt", () => {
    const bad: Array<[unknown, RegExp]> = [
      ["javascript:alert(1)", /https/],
      ["http://shopee.vn/x", /https/],
      ["https://evil.com/shopee.vn", /chỉ nhận/],
      ["https://shopee.vn.evil.com/x", /chỉ nhận/],
      ["https://evilshopee.vn/x", /chỉ nhận/],
      ["https://www.shopee.com/x", /chỉ nhận/],
      ["https://shopee.vn/a b", /khoảng trắng/],
      ["https://shopee.vn/" + "a".repeat(500), /dài quá 500/],
      ["", /không hợp lệ/],
      ["https://user:pass@shopee.vn/x", /không hợp lệ/],
      ["khongphailink", /không hợp lệ/],
      [123, /không hợp lệ/],
    ];
    for (const [u, re] of bad) {
      const r = validateShopeeUrl(u);
      assert.equal(r.ok, false, String(u));
      assert.match((r as any).message, re, String(u));
    }
    assert.equal(normalizeShopeeUrl(""), null);
    assert.equal(normalizeShopeeUrl(null), null);
    assert.throws(() => normalizeShopeeUrl("http://shopee.vn/x"), /https/);
  });
});

describe("migration v4", () => {
  test("DB v3 có dữ liệu -> thêm cột, giữ dữ liệu, chạy lại không lỗi", () => {
    const dir = tmpDir("shopee-mig");
    const db = new Db(dir, "old.db", 3);
    const now = new Date().toISOString();
    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.run("INSERT INTO fb_reel_posts (id, workspace_id, asset_id, status, caption, created_at, updated_at) VALUES ('old1', 'w1', 'astX', 'published', 'cap cũ', ?, ?)", now, now);
    db.run("INSERT INTO video_batches (id, workspace_id, name, mode, provider_config_id, model_id, config_json, max_concurrency, status, created_at, updated_at) VALUES ('bt1', 'w1', 'b', 'single', 'p', 'm', '{}', 1, 'completed', ?, ?)", now, now);
    migrate(db);
    migrate(db);
    const p = db.get<any>("SELECT * FROM fb_reel_posts WHERE id = 'old1'")!;
    assert.equal(p.caption, "cap cũ");
    assert.equal(p.shopee_url, null);
    assert.equal(p.comment_status, "none");
    assert.equal(p.fb_comment_id, null);
    assert.equal(p.comment_attempts, 0);
    assert.equal(db.get<any>("SELECT shopee_url FROM video_batches WHERE id = 'bt1'")!.shopee_url, null);
    assert.equal(db.all("SELECT 1 FROM schema_migrations WHERE version = 4").length, 1);
    db.close();
  });
});

describe("API tạo batch với link", () => {
  const body = (extra: Record<string, unknown>, prov: string) => ({ mode: "list", providerConfigId: prov, modelId: "mock-standard", config: { durationSec: 4, aspectRatio: "9:16", resolution: "480p", audio: false }, prompts: [{ prompt: "một cảnh thử" }], ...extra });
  test("link sai -> 400 tiếng Việt; link khi không chọn Page -> 400; hợp lệ -> lưu vào batch", async () => {
    const { env, c, ws } = await setup("shopee-api");
    try {
      const prov = mockProviderId(env, ws);
      const pg = mkPage(env, ws);
      const bad = await c.post("/api/batches", body({ fbPage: pg.id, shopeeUrl: "http://shopee.vn/x" }, prov));
      assert.equal(bad.status, 400);
      assert.match(JSON.stringify(bad.body), /https/);
      assert.match(JSON.stringify(bad.body), /SHOPEE_URL_INVALID/);
      assert.equal((await c.post("/api/batches", body({ fbPage: pg.id, shopeeUrl: "https://evil.com/x" }, prov))).status, 400);
      const none = await c.post("/api/batches", body({ fbPage: "none", shopeeUrl: LINK_A }, prov));
      assert.equal(none.status, 400);
      assert.match(JSON.stringify(none.body), /SHOPEE_NEEDS_PAGE/);
      assert.match(JSON.stringify(none.body), /Chỉ nhập link Shopee/);
      assert.equal(Number(env.ctx.db.get<any>("SELECT COUNT(*) n FROM video_batches WHERE workspace_id = ?", ws)!.n), 0, "không tạo batch khi bị từ chối");
      const ok = await c.post("/api/batches", body({ fbPage: pg.id, shopeeUrl: ` ${LINK_A} ` }, prov));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.batch.shopeeUrl, LINK_A);
      assert.equal(env.ctx.db.get<any>("SELECT shopee_url FROM video_batches WHERE id = ?", ok.body.batch.id)!.shopee_url, LINK_A);
      const nolink = await c.post("/api/batches", body({ fbPage: pg.id }, prov));
      assert.equal(nolink.body.batch.shopeeUrl, null);
    } finally {
      await env.close();
    }
  });
});

describe("sao chép link batch -> bài", () => {
  test("hai batch/hai Page khác link không lẫn; đổi batch sau enqueue không làm lệch bài", async () => {
    const { env, ws } = await setup("shopee-copy");
    try {
      const pa = mkPage(env, ws, PAGE_A);
      const pb = mkPage(env, ws, PAGE_B);
      const a1 = addVideo(env, ws, pa.id, LINK_A);
      const a2 = addVideo(env, ws, pb.id, LINK_B);
      const a3 = addVideo(env, ws, pa.id, null);
      for (const a of [a1, a2, a3]) enqueueReel(env.ctx, a);
      assert.equal(postOf(env, a1).shopee_url, LINK_A);
      assert.equal(postOf(env, a1).fb_page_id, pa.id);
      assert.equal(postOf(env, a2).shopee_url, LINK_B);
      assert.equal(postOf(env, a2).fb_page_id, pb.id);
      assert.equal(postOf(env, a3).shopee_url, null);
      assert.equal(postOf(env, a1).comment_status, "pending");
      assert.equal(postOf(env, a3).comment_status, "none");
      env.ctx.db.run("UPDATE video_batches SET shopee_url = 'https://shopee.vn/doi-roi'");
      assert.equal(postOf(env, a1).shopee_url, LINK_A);
      assert.equal(postOf(env, a2).shopee_url, LINK_B);
      const items = listQueue(env.ctx, ws).items;
      assert.equal(items.find((i) => i.assetId === a2)!.shopeeUrl, LINK_B);
      assert.equal(items.find((i) => i.assetId === a2)!.commentStatus, "pending");
    } finally {
      await env.close();
    }
  });
});

describe("caption có link", () => {
  test("link ở cuối sau hashtag; caption quá dài thì cắt nội dung, link nguyên vẹn; không link giữ như cũ", () => {
    const c = composeCaption("Nội dung hay", "#a #b", LINK_A);
    assert.equal(c, `Nội dung hay\n\n#a #b\n\n${SHOPEE_LINE_PREFIX}${LINK_A}`);
    const long = composeCaption("x".repeat(5000), "#a", LINK_A);
    assert.ok(long.length <= CAPTION_MAX, String(long.length));
    assert.ok(long.endsWith(`${SHOPEE_LINE_PREFIX}${LINK_A}`));
    const emo = composeCaption("😀".repeat(2000), "", LINK_A);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emo), "không cắt đôi emoji");
    assert.ok(emo.endsWith(LINK_A));
    assert.equal(composeCaption("Nội dung", "#a"), "Nội dung\n\n#a");
    assert.equal(composeCaption("x".repeat(5000), "").length, CAPTION_MAX);
    assert.ok(!composeCaption("Nội dung", "#a", null).includes("🛒"));
  });

  test("AI giả trả link bịa: bị bỏ, link thật của batch được ghép sau; link không đi vào prompt AI", async () => {
    const { env, ws } = await setup("shopee-ai");
    try {
      const pg = mkPage(env, ws, PAGE_A);
      saveSharedSettings(env.ctx, ws, { aiCaption: true });
      let seenPrompt = "";
      (env.ctx as any).llm = {
        model: () => "m",
        json: async (_w: string, o: any) => {
          seenPrompt = JSON.stringify(o);
          return { caption: "Xem ngay https://evil.com/phish nhé" };
        },
      };
      const g = fakeGraph();
      (env.ctx as any).fetchImpl = g.f;
      const a = addVideo(env, ws, pg.id, LINK_A);
      env.ctx.db.run("UPDATE video_batch_jobs SET prompt = 'cảnh thử'");
      enqueueReel(env.ctx, a);
      await mkPub(env, () => 1_700_000_000_000).tickOnce();
      const cap = postOf(env, a).caption as string;
      assert.ok(seenPrompt.includes("cảnh thử"), "AI đã được gọi");
      assert.ok(!cap.includes("evil.com"));
      assert.ok(cap.endsWith(`${SHOPEE_LINE_PREFIX}${LINK_A}`), cap);
      assert.ok(!seenPrompt.includes("shopee"), "AI không nhận link");
      const fin = g.calls.find((x) => x.body?.includes('"finish"'))!;
      assert.ok(JSON.parse(fin.body!).description.endsWith(LINK_A));
    } finally {
      await env.close();
    }
  });
});

describe("bình luận tự động", () => {
  test("sau published gọi đúng POST /{video_id}/comments với message chứa link; token không lộ trong API", async () => {
    const g = fakeGraph();
    const { env, c, ws } = await setup("shopee-c1", g.f);
    try {
      const pg = mkPage(env, ws);
      const a = addVideo(env, ws, pg.id, LINK_A);
      enqueueReel(env.ctx, a);
      await mkPub(env, () => 1_700_000_000_000).tickOnce();
      const p = postOf(env, a);
      assert.equal(p.status, "published");
      assert.equal(p.comment_status, "done");
      assert.equal(p.fb_comment_id, "c1");
      const cm = g.comments();
      assert.equal(cm.length, 1);
      assert.equal(cm[0]!.method, "POST");
      assert.match(cm[0]!.url, /graph\.facebook\.com\/v[\d.]+\/vid1\/comments$/);
      assert.equal(JSON.parse(cm[0]!.body!).message, `🛒 Link sản phẩm: ${LINK_A}`);
      const idxFinish = g.calls.findIndex((x) => x.body?.includes('"finish"'));
      assert.ok(idxFinish >= 0 && g.calls.indexOf(cm[0]!) > idxFinish, "bình luận sau finish");
      const api = await c.get("/api/facebook/reels/queue");
      assert.equal(api.status, 200);
      assert.ok(!JSON.stringify(api.body).includes(TOKEN));
      const item = api.body.items.find((i: any) => i.assetId === a);
      assert.equal(item.commentStatus, "done");
      assert.equal(item.shopeeUrl, LINK_A);
    } finally {
      await env.close();
    }
  });

  test("không gọi /comments trước khi published (bài chờ duyệt)", async () => {
    const g = fakeGraph();
    const { env, ws } = await setup("shopee-c2", g.f);
    try {
      const pg = mkPage(env, ws, PAGE_A, { requireApproval: true });
      const a = addVideo(env, ws, pg.id, LINK_A);
      enqueueReel(env.ctx, a);
      const pub = mkPub(env, () => 1_700_000_000_000);
      await pub.tickOnce();
      await pub.commentPass();
      assert.equal(postOf(env, a).status, "pending_review");
      assert.equal(g.calls.length, 0);
    } finally {
      await env.close();
    }
  });

  test("batch không có link: không bình luận, caption không có dòng 🛒", async () => {
    const g = fakeGraph();
    const { env, ws } = await setup("shopee-c3", g.f);
    try {
      const { a } = await publishOne(env, ws, null);
      const p = postOf(env, a);
      assert.equal(p.status, "published");
      assert.equal(p.comment_status, "none");
      assert.equal(g.comments().length, 0);
      assert.ok(!String(p.caption).includes("🛒"));
    } finally {
      await env.close();
    }
  });

  for (const mode of ["perm200", "http403"] as const) {
    test(`lỗi ${mode}: bài vẫn published, không đăng lại, comment failed + lý do pages_manage_engagement, Page không bị tạm dừng`, async () => {
      const g = fakeGraph([mode]);
      const { env, c, ws } = await setup(`shopee-e-${mode}`, g.f);
      try {
        const { a, pub, advance, pg } = await publishOne(env, ws, LINK_A);
        let p = postOf(env, a);
        assert.equal(p.status, "published");
        assert.equal(p.comment_status, "failed");
        assert.match(p.comment_error, /pages_manage_engagement/);
        assert.ok(!String(p.comment_error).includes(TOKEN));
        assert.equal(p.error_message, null);
        assert.equal(env.ctx.db.get<any>("SELECT pause_json FROM fb_pages WHERE id = ?", pg.id)!.pause_json, null);
        const upBefore = g.uploads().length;
        const startBefore = g.calls.filter((x) => x.body?.includes('"start"')).length;
        for (let i = 0; i < 4; i++) {
          advance(20 * 60_000);
          await pub.tickOnce();
        }
        p = postOf(env, a);
        assert.equal(p.status, "published");
        assert.equal(g.uploads().length, upBefore, "không đăng lại");
        assert.equal(g.calls.filter((x) => x.body?.includes('"start"')).length, startBefore);
        assert.equal(g.comments().length, 1, "lỗi quyền không tự thử lại");
        const r = await c.post(`/api/facebook/reels/queue/${p.id}/comment-retry`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(postOf(env, a).comment_status, "pending");
        await pub.tickOnce();
        p = postOf(env, a);
        assert.equal(p.comment_status, "done");
        assert.equal(p.status, "published");
        assert.equal(g.comments().length, 2, "1 lỗi + 1 thành công");
        assert.equal(g.uploads().length, upBefore);
      } finally {
        await env.close();
      }
    });
  }

  test("lỗi 5xx tạm thời: thử lại theo next_comment_at, tối đa 3 lần rồi failed", async () => {
    const g = fakeGraph(["e500", "e500", "e500", "e500"]);
    const { env, ws } = await setup("shopee-5xx", g.f);
    try {
      const { a, pub, advance } = await publishOne(env, ws, LINK_A);
      assert.equal(postOf(env, a).comment_status, "pending");
      assert.equal(g.comments().length, 1);
      await pub.tickOnce();
      assert.equal(g.comments().length, 1, "chưa tới hạn");
      advance(COMMENT_RETRY_DELAYS_MS[0]! + 1000);
      await pub.tickOnce();
      assert.equal(g.comments().length, 2);
      assert.equal(postOf(env, a).comment_status, "pending");
      advance(COMMENT_RETRY_DELAYS_MS[1]! + 1000);
      await pub.tickOnce();
      assert.equal(g.comments().length, 3);
      const p = postOf(env, a);
      assert.equal(p.comment_status, "failed");
      assert.match(p.comment_error, /3 lần/);
      assert.equal(p.status, "published");
      advance(60 * 60_000);
      await pub.tickOnce();
      assert.equal(g.comments().length, 3, "hết 3 lần thì dừng");
    } finally {
      await env.close();
    }
  });

  test("timeout mơ hồ: failed ngay (không tự thử lại để khỏi trùng), cảnh báo kiểm tra Page", async () => {
    const g = fakeGraph(["timeout"]);
    const { env, ws } = await setup("shopee-to", g.f);
    try {
      const { a, pub, advance } = await publishOne(env, ws, LINK_A);
      const p = postOf(env, a);
      assert.equal(p.comment_status, "failed");
      assert.match(p.comment_error, /kiểm tra trên Page/);
      advance(60 * 60_000);
      await pub.tickOnce();
      assert.equal(g.comments().length, 1);
      assert.equal(postOf(env, a).status, "published");
    } finally {
      await env.close();
    }
  });

  test("không trùng: retryComment sau done -> 409; tick lại không gọi lần hai; commentPass song song -> 1 call", async () => {
    const g = fakeGraph();
    const { env, c, ws } = await setup("shopee-dup", g.f);
    try {
      const { a, pub, advance } = await publishOne(env, ws, LINK_A);
      const p = postOf(env, a);
      assert.equal(p.comment_status, "done");
      assert.throws(() => retryComment(env.ctx, ws, p.id), (e: any) => e.status === 409);
      assert.equal((await c.post(`/api/facebook/reels/queue/${p.id}/comment-retry`)).status, 409);
      advance(60 * 60_000);
      await pub.tickOnce();
      await pub.tickOnce();
      assert.equal(g.comments().length, 1);
      env.ctx.db.run("UPDATE fb_reel_posts SET comment_status = 'pending' WHERE id = ?", p.id);
      await pub.commentPass();
      assert.equal(g.comments().length, 1, "đã có fb_comment_id thì không gọi");
      const pg2 = mkPage(env, ws, PAGE_B);
      const a2 = addVideo(env, ws, pg2.id, LINK_B);
      enqueueReel(env.ctx, a2);
      env.ctx.db.run("UPDATE fb_reel_posts SET status = 'published', fb_video_id = 'vidX', published_at = ? WHERE asset_id = ?", new Date().toISOString(), a2);
      await Promise.all([pub.commentPass(), mkPub(env, () => 1_700_000_000_000).commentPass(), pub.commentPass()]);
      assert.equal(g.comments().filter((x) => x.url.includes("/vidX/")).length, 1);
      assert.equal(postOf(env, a2).comment_status, "done");
    } finally {
      await env.close();
    }
  });
});

describe("sửa link một bài", () => {
  test("pending_review sửa được (validate); approved/published -> 409", async () => {
    const g = fakeGraph();
    const { env, c, ws } = await setup("shopee-edit", g.f);
    try {
      const pg = mkPage(env, ws, PAGE_A, { requireApproval: true });
      const a = addVideo(env, ws, pg.id, LINK_A);
      enqueueReel(env.ctx, a);
      const id = postOf(env, a).id;
      const bad = await c.req("PUT", `/api/facebook/reels/queue/${id}/shopee-url`, { shopeeUrl: "http://shopee.vn/x" });
      assert.equal(bad.status, 400);
      assert.equal(postOf(env, a).shopee_url, LINK_A);
      const ok = await c.req("PUT", `/api/facebook/reels/queue/${id}/shopee-url`, { shopeeUrl: LINK_B });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.shopeeUrl, LINK_B);
      assert.equal(postOf(env, a).comment_status, "pending");
      const del = await c.req("PUT", `/api/facebook/reels/queue/${id}/shopee-url`, { shopeeUrl: null });
      assert.equal(del.status, 200);
      assert.equal(postOf(env, a).shopee_url, null);
      assert.equal(postOf(env, a).comment_status, "none");
      setShopeeUrl(env.ctx, ws, id, LINK_B);
      approve(env.ctx, ws, id, "u");
      const conf = await c.req("PUT", `/api/facebook/reels/queue/${id}/shopee-url`, { shopeeUrl: LINK_A });
      assert.equal(conf.status, 409);
      assert.equal(postOf(env, a).shopee_url, LINK_B);
      await mkPub(env, () => 1_700_000_000_000).tickOnce();
      assert.equal(postOf(env, a).status, "published");
      assert.equal(g.comments().length, 1);
      assert.equal(JSON.parse(g.comments()[0]!.body!).message, `🛒 Link sản phẩm: ${LINK_B}`);
      assert.equal((await c.req("PUT", `/api/facebook/reels/queue/${id}/shopee-url`, { shopeeUrl: LINK_A })).status, 409);
    } finally {
      await env.close();
    }
  });
});
