import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEnv, tmpDir, userClient, type TestEnv } from "./helpers.ts";
import { checkReelEligibility } from "../src/fbreels/eligibility.ts";
import { getReelsConfig, getReelsPause, saveReelsConfig } from "../src/fbreels/config.ts";
import { GraphError, GraphReelsClient } from "../src/fbreels/graph.ts";
import { composeCaption, renderTemplate } from "../src/fbreels/caption.ts";
import { enqueueReel, listQueue, sweepMissing } from "../src/fbreels/queue.ts";
import { ReelsPublisher } from "../src/fbreels/publisher.ts";
import { newId } from "../src/util.ts";

const TOKEN = "EAAB_TEST_TOKEN_1234567890abcd";
const PAGE = "1234567890";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  size: number;
}

/** fetch giả cho Graph/rupload; ghi lại mọi lời gọi */
function fakeGraph(opts: { failStart?: unknown; statusSeq?: string[] } = {}) {
  const calls: Call[] = [];
  let vid = 0;
  const statuses = [...(opts.statusSeq ?? ["ready"])];
  const f = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init.body;
    calls.push({ url, method: init.method ?? "GET", headers: { ...(init.headers ?? {}) }, body: typeof body === "string" ? body : null, size: body && typeof body !== "string" ? (body as Buffer).length : 0 });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.includes("rupload.facebook.com")) return json({ success: true });
    if (url.includes("/video_reels")) {
      const b = JSON.parse(body);
      if (b.upload_phase === "start") {
        if (opts.failStart) return json(opts.failStart, 400);
        vid++;
        return json({ video_id: `vid${vid}`, upload_url: `https://rupload.facebook.com/video-upload/v26.0/vid${vid}` });
      }
      return json({ success: true });
    }
    if (url.includes("fields=status")) {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return json({ status: { video_status: s } });
    }
    return json({ id: PAGE, name: "Trang thử" });
  }) as typeof fetch;
  return { f, calls };
}

async function setup(name: string, fetchImpl?: typeof fetch) {
  const env = await createEnv(name);
  if (fetchImpl) (env.ctx as any).fetchImpl = fetchImpl;
  const c = await userClient(env, `u_${name}`);
  return { env, c, ws: c.workspaceId };
}

function addAsset(env: TestEnv, ws: string, o: { dur?: number; w?: number; h?: number; mime?: string } = {}): string {
  const id = newId("ast");
  const rel = `${ws}/${id}.mp4`;
  fs.mkdirSync(path.dirname(env.ctx.storage.abs(rel)), { recursive: true });
  fs.writeFileSync(env.ctx.storage.abs(rel), Buffer.alloc(2048, 7));
  env.ctx.db.run(
    `INSERT INTO video_assets (id, workspace_id, kind, origin, file_name, storage_path, mime, size_bytes, sha256, duration_sec, width, height, created_at)
     VALUES (?, ?, 'generated', 'provider', ?, ?, ?, 2048, ?, ?, ?, ?, ?)`,
    id, ws, `${id}.mp4`, rel, o.mime ?? "video/mp4", id, o.dur ?? 8, o.w ?? 1080, o.h ?? 1920, new Date().toISOString(),
  );
  return id;
}

const configure = (env: TestEnv, ws: string, p: Record<string, unknown> = {}) =>
  saveReelsConfig(env.ctx, ws, { pageId: PAGE, pageToken: TOKEN, ...p });

const statusOf = (env: TestEnv, assetId: string) => env.ctx.db.get<any>("SELECT * FROM fb_reel_posts WHERE asset_id = ?", assetId);

describe("điều kiện video Reels", () => {
  const base = { width: 1080, height: 1920, mime: "video/mp4" };
  test("ca biên thời lượng", () => {
    assert.equal(checkReelEligibility({ ...base, durationSec: 2.9 }).ok, false);
    assert.equal(checkReelEligibility({ ...base, durationSec: 3 }).ok, true);
    assert.equal(checkReelEligibility({ ...base, durationSec: 90 }).ok, true);
    const r = checkReelEligibility({ ...base, durationSec: 90.1 });
    assert.equal(r.ok, false);
    assert.match((r as any).reason, /dài hơn 90 giây/);
  });
  test("tỷ lệ, độ phân giải, thiếu probe, không phải mp4", () => {
    const r = checkReelEligibility({ durationSec: 10, width: 1920, height: 1080, mime: "video/mp4" });
    assert.equal(r.ok, false);
    assert.match((r as any).reason, /9:16/);
    assert.equal(checkReelEligibility({ durationSec: 10, width: 540, height: 960, mime: "video/mp4" }).ok, true);
    assert.equal(checkReelEligibility({ durationSec: 10, width: 539, height: 960, mime: "video/mp4" }).ok, false);
    assert.equal(checkReelEligibility({ durationSec: 10, width: 270, height: 480, mime: "video/mp4" }).ok, false);
    assert.match((checkReelEligibility({ durationSec: null, width: null, height: null }) as any).reason, /ffprobe/);
    assert.match((checkReelEligibility({ ...base, durationSec: 10, mime: "video/webm" }) as any).reason, /MP4/);
  });
});

describe("caption", () => {
  test("mẫu + hashtag", () => {
    assert.equal(renderTemplate("{tieu_de}: {prompt}", { prompt: "mèo", tieu_de: "A" }), "A: mèo");
    assert.equal(composeCaption("xin chào", "#a b, #A  c"), "xin chào\n\n#a #b #c");
    assert.ok(composeCaption("x".repeat(3000), "").length <= 2200);
  });
});

describe("cấu hình & che token", () => {
  test("mặc định, che token, validate", async () => {
    const { env, c, ws } = await setup("cfg");
    try {
      const d = (await c.get("/api/facebook/reels/config")).body;
      assert.equal(d.requireApproval, true);
      assert.equal(d.autoEnabled, false);
      assert.equal(d.intervalMin, 60);
      assert.equal(d.tokenConfigured, false);
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...a) => logs.push(a.join(" "));
      let put;
      try {
        put = await c.req("PUT", "/api/facebook/reels/config", { pageId: PAGE, pageToken: TOKEN, hashtags: "#bvs" });
      } finally {
        console.log = orig;
      }
      assert.equal(put.status, 200);
      assert.equal(put.body.tokenConfigured, true);
      assert.equal(put.body.tokenLast4, TOKEN.slice(-4));
      assert.ok(!put.raw.toString().includes(TOKEN));
      assert.ok(!(await c.get("/api/facebook/reels/config")).raw.toString().includes(TOKEN));
      assert.ok(!logs.join("\n").includes(TOKEN));
      const row = env.ctx.db.get<any>("SELECT value_json, secret_enc FROM settings WHERE workspace_id = ? AND key = 'facebook_reels'", ws);
      assert.ok(!row.value_json.includes(TOKEN));
      assert.ok(row.secret_enc && !row.secret_enc.includes(TOKEN));
      assert.equal(env.ctx.secrets.decrypt(row.secret_enc), TOKEN);
      const audits = JSON.stringify(env.ctx.db.all("SELECT * FROM audit_log"));
      assert.ok(!audits.includes(TOKEN));
      assert.equal((await c.req("PUT", "/api/facebook/reels/config", { graphVersion: "26" })).status, 400);
      assert.equal((await c.req("PUT", "/api/facebook/reels/config", { intervalMin: 1 })).status, 400);
      // để trống token = giữ nguyên
      assert.equal((await c.req("PUT", "/api/facebook/reels/config", { intervalMin: 30 })).body.tokenConfigured, true);
      // bật tự động khi thiếu token
      const { env: e2, c: c2 } = await setup("cfg2");
      try {
        assert.equal((await c2.req("PUT", "/api/facebook/reels/config", { autoEnabled: true })).status, 400);
      } finally {
        await e2.close();
      }
    } finally {
      await env.close();
    }
  });
});

describe("client Graph", () => {
  test("3 bước đúng URL/header/body, polling, không token trên URL", async () => {
    const g = fakeGraph({ statusSeq: ["processing", "processing", "ready"] });
    const file = path.join(tmpDir("g1"), "v.mp4");
    fs.writeFileSync(file, Buffer.alloc(1000, 1));
    const sleeps: number[] = [];
    const cl = new GraphReelsClient({ fetchImpl: g.f, pageId: PAGE, version: "v26.0", token: TOKEN, sleep: async (ms) => void sleeps.push(ms) });
    const { videoId, uploadUrl } = await cl.startUpload();
    await cl.uploadFile(uploadUrl, file);
    await cl.finish(videoId, "cap #x");
    await cl.waitUntilReady(videoId);
    const [s, u, f, ...st] = g.calls;
    assert.equal(s!.url, `https://graph.facebook.com/v26.0/${PAGE}/video_reels`);
    assert.equal(s!.method, "POST");
    assert.equal(JSON.parse(s!.body!).upload_phase, "start");
    assert.ok(u!.url.startsWith("https://rupload.facebook.com/"));
    assert.equal(u!.headers.Authorization, `OAuth ${TOKEN}`);
    assert.equal(u!.headers.offset, "0");
    assert.equal(u!.headers.file_size, "1000");
    assert.equal(u!.size, 1000);
    const fb = JSON.parse(f!.body!);
    assert.equal(fb.upload_phase, "finish");
    assert.equal(fb.video_state, "PUBLISHED");
    assert.equal(fb.description, "cap #x");
    assert.equal(fb.video_id, "vid1");
    assert.equal(st.length, 3);
    assert.deepEqual(sleeps, [15000, 15000]);
    for (const c of g.calls) assert.ok(!c.url.includes(TOKEN) && !c.url.includes("access_token"));
  });
  test("lỗi token / rate limit / hết hạn polling, không retry, che token", async () => {
    const mk = (err: unknown, status = 400) => {
      let n = 0;
      const f = (async () => {
        n++;
        return new Response(JSON.stringify(err), { status });
      }) as typeof fetch;
      return { cl: new GraphReelsClient({ fetchImpl: f, pageId: PAGE, version: "v26.0", token: TOKEN, sleep: async () => {} }), count: () => n };
    };
    const a = mk({ error: { message: `Invalid OAuth access token ${TOKEN}`, type: "OAuthException", code: 190 } });
    await assert.rejects(a.cl.startUpload(), (e: GraphError) => e.kind === "token" && !e.message.includes(TOKEN) && /hết hạn/.test(e.message));
    assert.equal(a.count(), 1);
    const b = mk({ error: { message: `limit ${TOKEN}`, code: 4 } });
    await assert.rejects(b.cl.startUpload(), (e: GraphError) => e.kind === "rate_limit" && !e.message.includes(TOKEN));
    const p = mk({ error: { message: "x", code: 200 } });
    await assert.rejects(p.cl.startUpload(), (e: GraphError) => e.kind === "permission");
    const r429 = mk({}, 429);
    await assert.rejects(r429.cl.startUpload(), (e: GraphError) => e.kind === "rate_limit");
    const g = fakeGraph({ statusSeq: ["processing"] });
    const cl = new GraphReelsClient({ fetchImpl: g.f, pageId: PAGE, version: "v26.0", token: TOKEN, sleep: async () => {} });
    await assert.rejects(cl.waitUntilReady("v1", { maxMs: 60_000, everyMs: 15_000 }), /10 phút/);
    assert.equal(g.calls.length, 5);
  });
});

describe("hàng đợi, duyệt, lập lịch", () => {
  test("chưa cấu hình thì không enqueue; enqueue idempotent; bỏ qua video sai", async () => {
    const { env, ws } = await setup("enq");
    try {
      const a = addAsset(env, ws);
      assert.equal(enqueueReel(env.ctx, a), false);
      configure(env, ws, { autoEnabled: true });
      // tắt tự động thì không xếp hàng (S4)
      saveReelsConfig(env.ctx, ws, { autoEnabled: false });
      assert.equal(enqueueReel(env.ctx, a), false);
      saveReelsConfig(env.ctx, ws, { autoEnabled: true });
      assert.equal(enqueueReel(env.ctx, a), true);
      assert.equal(enqueueReel(env.ctx, a), false);
      assert.equal(env.ctx.db.all("SELECT 1 FROM fb_reel_posts").length, 1);
      assert.equal(statusOf(env, a).status, "pending_review");
      const bad = addAsset(env, ws, { w: 1920, h: 1080 });
      enqueueReel(env.ctx, bad);
      assert.equal(statusOf(env, bad).status, "skipped");
      assert.match(statusOf(env, bad).skip_reason, /9:16/);
      const noReq = await setup("enq2");
      try {
        configure(noReq.env, noReq.ws, { requireApproval: false, autoEnabled: true });
        const x = addAsset(noReq.env, noReq.ws);
        enqueueReel(noReq.env.ctx, x);
        assert.equal(statusOf(noReq.env, x).status, "approved");
      } finally {
        await noReq.env.close();
      }
    } finally {
      await env.close();
    }
  });

  test("không gọi Facebook trước khi duyệt; từ chối không đăng; route 404/409; xoá không mất file", async () => {
    const g = fakeGraph();
    const { env, c, ws } = await setup("appr", g.f);
    try {
      configure(env, ws, { autoEnabled: true });
      const a = addAsset(env, ws);
      const r = addAsset(env, ws);
      enqueueReel(env.ctx, a);
      enqueueReel(env.ctx, r);
      let t = 1_000_000_000_000;
      const pub = new ReelsPublisher(env.ctx, { now: () => t, sleep: async () => {}, log: () => {}, pollEveryMs: 1 });
      await pub.tickOnce();
      assert.equal(g.calls.length, 0);
      const qid = statusOf(env, a).id;
      const rid = statusOf(env, r).id;
      assert.equal((await c.post(`/api/facebook/reels/queue/${rid}/reject`)).status, 200);
      assert.equal((await c.post(`/api/facebook/reels/queue/${rid}/reject`)).status, 409);
      assert.equal((await c.post(`/api/facebook/reels/queue/nope/approve`)).status, 404);
      assert.equal((await c.post(`/api/facebook/reels/queue/${qid}/approve`)).status, 200);
      assert.equal((await c.post(`/api/facebook/reels/queue/${qid}/approve`)).status, 409);
      await pub.tickOnce();
      assert.equal(g.calls.filter((x) => x.url.includes("rupload")).length, 1);
      assert.equal(statusOf(env, a).status, "published");
      assert.equal(statusOf(env, r).status, "rejected");
      const q = (await c.get("/api/facebook/reels/queue")).body;
      assert.equal(q.items.length, 2);
      assert.ok(!JSON.stringify(q).includes(TOKEN));
      assert.equal((await c.req("DELETE", `/api/facebook/reels/queue/${qid}`)).status, 200);
      assert.equal(env.ctx.db.get<any>("SELECT status FROM fb_reel_posts WHERE id = ?", qid).status, "removed");
      assert.ok(env.ctx.db.get("SELECT 1 FROM video_assets WHERE id = ?", a));
      assert.ok(fs.existsSync(env.ctx.storage.abs(`${ws}/${a}.mp4`)));
      assert.equal(listQueue(env.ctx, ws).items.length, 1);
    } finally {
      await env.close();
    }
  });

  test("đăng đều: cách nhau >= khoảng cách cấu hình", async () => {
    const g = fakeGraph();
    const { env, ws } = await setup("sched", g.f);
    try {
      configure(env, ws, { autoEnabled: true, requireApproval: false, intervalMin: 60 });
      const ids = [addAsset(env, ws), addAsset(env, ws), addAsset(env, ws)];
      ids.forEach((i) => enqueueReel(env.ctx, i));
      const t0 = 1_700_000_000_000;
      let t = t0;
      const pub = new ReelsPublisher(env.ctx, { now: () => t, sleep: async () => {}, log: () => {}, pollEveryMs: 1 });
      const published = () => env.ctx.db.all("SELECT 1 FROM fb_reel_posts WHERE status = 'published'").length;
      await pub.tickOnce();
      assert.equal(published(), 1);
      t = t0 + 59 * 60_000;
      await pub.tickOnce();
      assert.equal(published(), 1);
      t = t0 + 60 * 60_000;
      await pub.tickOnce();
      assert.equal(published(), 2);
      await pub.tickOnce(); // cùng thời điểm: không đăng dồn
      assert.equal(published(), 2);
      t = t0 + 120 * 60_000;
      await pub.tickOnce();
      assert.equal(published(), 3);
      // đồng hồ lùi: kẹp, không kẹt vô hạn
      assert.equal(g.calls.filter((x) => x.url.includes("rupload")).length, 3);
    } finally {
      await env.close();
    }
  });

  test("lỗi Graph không phân loại -> failed có thông báo, không tự thử lại; Đăng lại -> approved", async () => {
    const g = fakeGraph({ failStart: { error: { message: `bad ${TOKEN}`, code: 100 } } });
    const { env, c, ws } = await setup("fail", g.f);
    try {
      configure(env, ws, { autoEnabled: true, requireApproval: false, intervalMin: 5 });
      const a = addAsset(env, ws);
      enqueueReel(env.ctx, a);
      let t = 1_700_000_000_000;
      const pub = new ReelsPublisher(env.ctx, { now: () => t, sleep: async () => {}, log: () => {} });
      await pub.tickOnce();
      const row = statusOf(env, a);
      assert.equal(row.status, "failed");
      assert.ok(row.error_message && !row.error_message.includes(TOKEN));
      t += 10 * 60_000;
      await pub.tickOnce();
      await pub.tickOnce();
      assert.equal(g.calls.length, 1, "không tự thử lại");
      assert.equal((await c.post(`/api/facebook/reels/queue/${row.id}/retry`)).status, 200);
      assert.equal(statusOf(env, a).status, "approved");
      assert.equal(statusOf(env, a).error_message, null);
    } finally {
      await env.close();
    }
  });

  test("restart: step chưa finish -> failed; đã finishing -> chỉ polling, không gọi finish lại; hai publisher không claim trùng", async () => {
    const g = fakeGraph();
    const { env, ws } = await setup("rec", g.f);
    try {
      configure(env, ws, { autoEnabled: true, requireApproval: false });
      const a = addAsset(env, ws);
      const b = addAsset(env, ws);
      enqueueReel(env.ctx, a);
      enqueueReel(env.ctx, b);
      env.ctx.db.run("UPDATE fb_reel_posts SET status='publishing', step='uploaded', fb_video_id='v9' WHERE asset_id = ?", a);
      env.ctx.db.run("UPDATE fb_reel_posts SET status='publishing', step='finishing', fb_video_id='v10' WHERE asset_id = ?", b);
      const pub = new ReelsPublisher(env.ctx, { sleep: async () => {}, log: () => {}, pollEveryMs: 1 });
      await pub.recover();
      assert.equal(statusOf(env, a).status, "failed");
      assert.match(statusOf(env, a).error_message, /khởi động lại/);
      assert.equal(statusOf(env, b).status, "published");
      assert.equal(g.calls.some((x) => x.body?.includes("finish")), false);
      assert.equal(g.calls.some((x) => x.url.includes("rupload")), false);
    } finally {
      await env.close();
    }
    const g2 = fakeGraph();
    const s2 = await setup("race", g2.f);
    try {
      configure(s2.env, s2.ws, { autoEnabled: true, requireApproval: false });
      const x = addAsset(s2.env, s2.ws);
      enqueueReel(s2.env.ctx, x);
      const t = 1_700_000_000_000;
      const p1 = new ReelsPublisher(s2.env.ctx, { now: () => t, sleep: async () => {}, log: () => {}, pollEveryMs: 1 });
      const p2 = new ReelsPublisher(s2.env.ctx, { now: () => t, sleep: async () => {}, log: () => {}, pollEveryMs: 1 });
      await Promise.all([p1.tickOnce(), p2.tickOnce()]);
      assert.equal(g2.calls.filter((c) => c.url.includes("rupload")).length, 1);
    } finally {
      await s2.env.close();
    }
  });

  test("kiểm tra kết nối cấu hình (mock)", async () => {
    const g = fakeGraph();
    const { env, c } = await setup("conn", g.f);
    try {
      assert.equal((await c.post("/api/facebook/reels/config/test")).status, 409);
      await c.req("PUT", "/api/facebook/reels/config", { pageId: PAGE, pageToken: TOKEN });
      const r = await c.post("/api/facebook/reels/config/test");
      assert.equal(r.body.ok, true);
      assert.equal(r.body.pageName, "Trang thử");
      assert.ok(!r.raw.toString().includes(TOKEN));
    } finally {
      await env.close();
    }
  });
});

void getReelsConfig;

// ---------------------------------------------------------------- vòng sửa theo review của Rex
const mkPub = (env: TestEnv, t: () => number, extra: Record<string, unknown> = {}) =>
  new ReelsPublisher(env.ctx, { now: t, sleep: async () => {}, log: () => {}, pollEveryMs: 1, ...extra });
const rupCount = (g: { calls: Call[] }) => g.calls.filter((x) => x.url.includes("rupload")).length;

describe("B1 xoá khỏi hàng rồi tick", () => {
  test("xoá dòng đã published (không cần duyệt) -> tick không đăng lần hai, không hiện lại", async () => {
    const g = fakeGraph();
    const { env, c, ws } = await setup("b1a", g.f);
    try {
      configure(env, ws, { autoEnabled: true, requireApproval: false, intervalMin: 5 });
      // job completed thật để sweepMissing nhặt được video (đường tự xếp lại trong review)
      const a = addAsset(env, ws);
      const now = new Date().toISOString();
      const bid = newId("bat");
      const jid = newId("job");
      env.ctx.db.run(
        "INSERT INTO video_batches (id, workspace_id, name, mode, provider_config_id, model_id, config_json, max_concurrency, status, created_at, updated_at) VALUES (?, ?, 'b', 'single', 'p', 'm', '{}', 1, 'completed', ?, ?)",
        bid, ws, now, now,
      );
      env.ctx.db.run(
        "INSERT INTO video_batch_jobs (id, batch_id, workspace_id, seq, prompt, provider_config_id, model_id, config_json, status, output_asset_id, lineage_id, created_at, updated_at) VALUES (?, ?, ?, 1, 'p', 'p', 'm', '{}', 'completed', ?, ?, ?, ?)",
        jid, bid, ws, a, jid, now, now,
      );
      env.ctx.db.run("UPDATE video_assets SET source_job_id = ? WHERE id = ?", jid, a);
      let t = 1_700_000_000_000;
      const pub = mkPub(env, () => t);
      await pub.tickOnce(); // sweepMissing xếp (approved) rồi đăng
      assert.equal(statusOf(env, a).status, "published");
      assert.equal((await c.req("DELETE", `/api/facebook/reels/queue/${statusOf(env, a).id}`)).status, 200);
      for (let i = 0; i < 3; i++) {
        t += 10 * 60_000;
        await pub.tickOnce();
      }
      assert.equal(rupCount(g), 1, "không đăng lại");
      assert.equal(env.ctx.db.all("SELECT 1 FROM fb_reel_posts WHERE asset_id = ?", a).length, 1, "dòng dấu vẫn còn, enqueue không tạo mới");
      assert.equal(enqueueReel(env.ctx, a), false);
      assert.equal(listQueue(env.ctx, ws).items.length, 0);
    } finally {
      await env.close();
    }
  });
  test("sweepMissing bỏ qua dòng removed (pending_review xoá xong không hiện lại)", async () => {
    const { env, c, ws } = await setup("b1b", fakeGraph().f);
    try {
      configure(env, ws, { autoEnabled: true });
      const a = addAsset(env, ws);
      enqueueReel(env.ctx, a);
      const id = statusOf(env, a).id;
      assert.equal((await c.req("DELETE", `/api/facebook/reels/queue/${id}`)).status, 200);
      assert.equal(sweepMissing(env.ctx, ws), 0);
      assert.equal(listQueue(env.ctx, ws).items.length, 0);
      assert.equal((await c.req("DELETE", `/api/facebook/reels/queue/${id}`)).status, 404);
      assert.equal((await c.post(`/api/facebook/reels/queue/${id}/approve`)).status, 404);
    } finally {
      await env.close();
    }
  });
});

describe("B2 tạm dừng khi lỗi token/quyền; thử lại lỗi tạm thời", () => {
  for (const [name, err, kind] of [
    ["190", { error: { message: "x", code: 190, type: "OAuthException" } }, "token"],
    ["492", { error: { message: "x", code: 492 } }, "permission"],
    ["200", { error: { message: "x", code: 200 } }, "permission"],
  ] as const) {
    test(`mã ${name} -> tạm dừng hàng đợi, bài về approved, Tiếp tục mới đăng`, async () => {
      const g = fakeGraph({ failStart: err });
      const { env, c, ws } = await setup(`b2_${name}`, g.f);
      try {
        configure(env, ws, { autoEnabled: true, requireApproval: false, intervalMin: 5 });
        const a = addAsset(env, ws);
        const b = addAsset(env, ws);
        enqueueReel(env.ctx, a);
        enqueueReel(env.ctx, b);
        let t = 1_700_000_000_000;
        const pub = mkPub(env, () => t);
        await pub.tickOnce();
        assert.equal(g.calls.length, 1, "auth không thử lại");
        const q = (await c.get("/api/facebook/reels/queue")).body;
        assert.equal(q.pause.kind, kind);
        assert.ok(!JSON.stringify(q).includes(TOKEN));
        assert.deepEqual(env.ctx.db.all<any>("SELECT status FROM fb_reel_posts").map((r) => r.status).sort(), ["approved", "approved"]);
        t += 60 * 60_000;
        await pub.tickOnce();
        await pub.tickOnce();
        assert.equal(g.calls.length, 1, "đang tạm dừng: không gọi Facebook");
        assert.equal((await c.post("/api/facebook/reels/resume")).status, 200);
        assert.equal((await c.get("/api/facebook/reels/queue")).body.pause, null);
        await pub.tickOnce();
        assert.equal(g.calls.length, 2, "sau Tiếp tục thì thử đăng lại");
      } finally {
        await env.close();
      }
    });
  }
  test("lỗi 5xx/mạng/rate-limit ở start: thử tối đa 3 lần giãn cách tăng dần rồi failed; thành công giữa chừng thì đăng", async () => {
    // luôn lỗi 500
    let n = 0;
    const calls: Call[] = [];
    const bad = (async (input: any, init: any = {}) => {
      n++;
      calls.push({ url: String(input), method: "POST", headers: {}, body: init.body ?? null, size: 0 });
      return new Response(JSON.stringify({ error: { message: "oops", code: 2 } }), { status: 500 });
    }) as typeof fetch;
    const { env, ws } = await setup("b2_retry", bad);
    try {
      configure(env, ws, { autoEnabled: true, requireApproval: false, intervalMin: 5 });
      const a = addAsset(env, ws);
      enqueueReel(env.ctx, a);
      const sleeps: number[] = [];
      const pub = mkPub(env, () => 1_700_000_000_000, { sleep: async (ms: number) => void sleeps.push(ms) });
      await pub.tickOnce();
      assert.equal(n, 4, "1 lần đầu + 3 lần thử lại");
      assert.deepEqual(sleeps, [2000, 5000, 15000]);
      assert.equal(statusOf(env, a).status, "failed");
      assert.equal(env.ctx.db.get<any>("SELECT COUNT(*) c FROM settings WHERE key='facebook_reels_state' AND value_json LIKE '%pause%\"kind%'").c, 0);
    } finally {
      await env.close();
    }
    // lỗi mạng 2 lần rồi ổn
    const g = fakeGraph();
    let fail = 2;
    const flaky = (async (input: any, init: any) => {
      if (String(input).includes("/video_reels") && JSON.parse(init.body).upload_phase === "start" && fail-- > 0) throw new TypeError("fetch failed");
      return g.f(input, init);
    }) as typeof fetch;
    const s2 = await setup("b2_retry2", flaky);
    try {
      configure(s2.env, s2.ws, { autoEnabled: true, requireApproval: false });
      const a = addAsset(s2.env, s2.ws);
      enqueueReel(s2.env.ctx, a);
      await mkPub(s2.env, () => 1_700_000_000_000).tickOnce();
      assert.equal(statusOf(s2.env, a).status, "published");
      assert.equal(rupCount(g), 1);
    } finally {
      await s2.env.close();
    }
  });
  test("lỗi upload tạm thời cũng được thử lại; lỗi ở finish thì KHÔNG thử lại", async () => {
    const g = fakeGraph();
    let upFail = 1;
    let finishCalls = 0;
    const f = (async (input: any, init: any) => {
      const url = String(input);
      if (url.includes("rupload") && upFail-- > 0) return new Response("{}", { status: 503 });
      if (url.includes("/video_reels") && JSON.parse(init.body).upload_phase === "finish") {
        finishCalls++;
        return new Response(JSON.stringify({ error: { message: "tmp", code: 2 } }), { status: 500 });
      }
      return g.f(input, init);
    }) as typeof fetch;
    const { env, ws } = await setup("b2_fin", f);
    try {
      configure(env, ws, { autoEnabled: true, requireApproval: false });
      const a = addAsset(env, ws);
      enqueueReel(env.ctx, a);
      await mkPub(env, () => 1_700_000_000_000).tickOnce();
      assert.equal(rupCount(g), 1, "upload lỗi 503 rồi thử lại thành công (chỉ lần thành công tới được fake)");
      assert.equal(finishCalls, 1, "finish đúng 1 lần, không thử lại");
      const row = statusOf(env, a);
      assert.equal(row.status, "failed");
      assert.match(row.error_message, /kiểm tra Page/);
    } finally {
      await env.close();
    }
  });
  test("lỗi token ở finish (mơ hồ) -> failed + tạm dừng, không về approved", async () => {
    const g = fakeGraph();
    const f = (async (input: any, init: any) => {
      if (String(input).includes("/video_reels") && JSON.parse(init.body).upload_phase === "finish") return new Response(JSON.stringify({ error: { message: "t", code: 190 } }), { status: 400 });
      return g.f(input, init);
    }) as typeof fetch;
    const { env, ws } = await setup("b2_fin2", f);
    try {
      configure(env, ws, { autoEnabled: true, requireApproval: false });
      const a = addAsset(env, ws);
      enqueueReel(env.ctx, a);
      await mkPub(env, () => 1_700_000_000_000).tickOnce();
      assert.equal(statusOf(env, a).status, "failed");
      assert.equal(getReelsPause(env.ctx, ws)?.kind, "token");
    } finally {
      await env.close();
    }
  });
  test("phân loại Graph: 492 là permission, 5xx là server, mạng là network", async () => {
    const mk = (err: unknown, status = 400) => new GraphReelsClient({ fetchImpl: (async () => new Response(JSON.stringify(err), { status })) as typeof fetch, pageId: PAGE, version: "v26.0", token: TOKEN });
    await assert.rejects(mk({ error: { code: 492, message: "x" } }).startUpload(), (e: GraphError) => e.kind === "permission");
    await assert.rejects(mk({}, 502).startUpload(), (e: GraphError) => e.kind === "server");
    const net = new GraphReelsClient({ fetchImpl: (async () => { throw new TypeError("boom"); }) as typeof fetch, pageId: PAGE, version: "v26.0", token: TOKEN });
    await assert.rejects(net.startUpload(), (e: GraphError) => e.kind === "network");
  });
});

describe("S1 recover không phá bài của tiến trình khác", () => {
  test("chỉ recover dòng publishing cũ hơn 15 phút; markPublished/markFailed cần status=publishing", async () => {
    const g = fakeGraph();
    const { env, ws } = await setup("s1", g.f);
    try {
      configure(env, ws, { autoEnabled: true, requireApproval: false });
      const fresh = addAsset(env, ws);
      const old = addAsset(env, ws);
      enqueueReel(env.ctx, fresh);
      enqueueReel(env.ctx, old);
      const now = 1_700_000_000_000;
      env.ctx.db.run("UPDATE fb_reel_posts SET status='publishing', step='uploaded', fb_video_id='v1', publishing_at=? WHERE asset_id = ?", new Date(now - 60_000).toISOString(), fresh);
      env.ctx.db.run("UPDATE fb_reel_posts SET status='publishing', step='uploaded', fb_video_id='v2', publishing_at=? WHERE asset_id = ?", new Date(now - 16 * 60_000).toISOString(), old);
      await mkPub(env, () => now).recover();
      assert.equal(statusOf(env, fresh).status, "publishing", "bài mới của tiến trình khác giữ nguyên");
      assert.equal(statusOf(env, old).status, "failed");
      // bài đã bị đánh dấu khác thì markPublished/markFailed không ghi đè
      const pub = mkPub(env, () => now) as any;
      pub.markPublished(statusOf(env, old).id);
      assert.equal(statusOf(env, old).status, "failed");
      pub.markFailed(statusOf(env, fresh).id, new Error("x"));
      assert.equal(statusOf(env, fresh).status, "failed");
      env.ctx.db.run("UPDATE fb_reel_posts SET status='published' WHERE asset_id = ?", fresh);
      pub.markFailed(statusOf(env, fresh).id, new Error("y"));
      assert.equal(statusOf(env, fresh).status, "published");
    } finally {
      await env.close();
    }
  });
});

describe("S2 chỉ gửi token tới host Facebook", () => {
  test("upload_url lạ / http -> báo lỗi, không gửi", async () => {
    const file = path.join(tmpDir("s2"), "v.mp4");
    fs.writeFileSync(file, Buffer.alloc(100, 1));
    for (const bad of ["https://evil.example.com/up", "http://rupload.facebook.com/x", "https://facebook.com.evil.io/x", "https://evilfacebook.com/x", "not a url"]) {
      const g = fakeGraph();
      const cl = new GraphReelsClient({ fetchImpl: g.f, pageId: PAGE, version: "v26.0", token: TOKEN });
      await assert.rejects(cl.uploadFile(bad, file), /không hợp lệ/);
      assert.equal(g.calls.length, 0, bad);
    }
    for (const good of ["https://rupload.facebook.com/video-upload/v26.0/1", "https://cdn.fbcdn.net/x"]) {
      const g = fakeGraph();
      const cl = new GraphReelsClient({ fetchImpl: g.f, pageId: PAGE, version: "v26.0", token: TOKEN });
      await cl.uploadFile(good, file);
      assert.equal(g.calls.length, 1);
    }
  });
});

describe("S3 renderTemplate không nội suy $", () => {
  test("$& $1 $' giữ nguyên", () => {
    assert.equal(renderTemplate("{prompt}|{tieu_de}", { prompt: "a $& b $1 c $' d $$", tieu_de: "$`x" }), "a $& b $1 c $' d $$|$`x");
  });
});

describe("S4 tắt rồi bật lại tự động", () => {
  test("video làm lúc tắt không vào hàng; enabledSince cập nhật mỗi lần bật", async () => {
    const { env, ws } = await setup("s4");
    try {
      configure(env, ws, { autoEnabled: true });
      const s1 = getReelsConfig(env.ctx, ws).enabledSince;
      assert.ok(s1);
      saveReelsConfig(env.ctx, ws, { autoEnabled: false });
      const during = addAsset(env, ws);
      assert.equal(enqueueReel(env.ctx, during), false);
      assert.equal(sweepMissing(env.ctx, ws), 0);
      await new Promise((r) => setTimeout(r, 5));
      saveReelsConfig(env.ctx, ws, { autoEnabled: true });
      const s2 = getReelsConfig(env.ctx, ws).enabledSince!;
      assert.ok(s2 > s1!);
      assert.equal(sweepMissing(env.ctx, ws), 0, "video cũ (trước mốc mới) không được xếp");
      assert.equal(env.ctx.db.all("SELECT 1 FROM fb_reel_posts").length, 0);
    } finally {
      await env.close();
    }
  });
});

describe("S6 retry bài đã từ chối", () => {
  test("requireApproval=true -> pending_review; =false -> approved", async () => {
    const { env, c, ws } = await setup("s6", fakeGraph().f);
    try {
      configure(env, ws, { autoEnabled: true });
      const a = addAsset(env, ws);
      enqueueReel(env.ctx, a);
      const id = statusOf(env, a).id;
      await c.post(`/api/facebook/reels/queue/${id}/reject`);
      assert.equal((await c.post(`/api/facebook/reels/queue/${id}/retry`)).status, 200);
      assert.equal(statusOf(env, a).status, "pending_review");
      assert.equal(statusOf(env, a).approved_at, null);
      await c.post(`/api/facebook/reels/queue/${id}/reject`);
      saveReelsConfig(env.ctx, ws, { requireApproval: false });
      assert.equal((await c.post(`/api/facebook/reels/queue/${id}/retry`)).status, 200);
      assert.equal(statusOf(env, a).status, "approved");
    } finally {
      await env.close();
    }
  });
});
