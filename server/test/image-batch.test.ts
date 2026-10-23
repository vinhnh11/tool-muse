import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createEnv, userClient, mockProviderId, tuneMock, waitFor, type Client, type TestEnv } from "./helpers.ts";
import { run } from "../src/media.ts";
import { Scheduler } from "../src/scheduler.ts";

/**
 * Tạo ảnh hàng loạt - chạy với muse2api GIẢ dựng theo app.py (POST /v1/images/tasks có
 * Idempotency-Key, GET /v1/images/tasks/{id}, GET /v1/media/*). KHÔNG gọi muse thật, KHÔNG tiêu hạn mức.
 */
const envs: TestEnv[] = [];
const servers: http.Server[] = [];
after(async () => {
  for (const e of envs) await e.close().catch(() => {});
  for (const s of servers) await new Promise((r) => s.close(r));
});

interface FakeOpts {
  /** Số lần poll trả "processing" trước khi xong */
  processingPolls?: number;
  relativeUrl?: boolean;
  /** 429 "Image queue is full" cho N POST đầu */
  rateLimitFirst?: number;
  /** Task được tạo nhưng ngắt kết nối trước khi trả lời, N POST đầu (mất phản hồi) */
  dropResponseFirst?: number;
  /** Chặn không bao giờ xong (luôn processing) */
  never?: boolean;
}

const KEY = "m2a_img_test_key_123456";

async function makeWebp(env: TestEnv, file: string): Promise<void> {
  try {
    await run(env.ctx.media.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=400x400", "-frames:v", "1", file]);
  } catch {
    await run(env.ctx.media.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=400x400", "-frames:v", "1", "-f", "image2", "-c:v", "png", file]);
  }
}

async function fakeImageApi(env: TestEnv, opts: FakeOpts = {}) {
  const requests: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
  const mediaDir = path.join(env.dir, "fake-img-media");
  fs.mkdirSync(mediaDir, { recursive: true });
  await makeWebp(env, path.join(mediaDir, "x.webp"));
  const tasks = new Map<string, { id: string; polls: number; prompt: string; attempts: number }>();
  const byKey = new Map<string, { bodyRaw: string; id: string }>();
  let seq = 0;
  let posts = 0;
  const failCounts = new Map<string, number>();

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const url = req.url ?? "";
    requests.push({ method: req.method ?? "", url, headers: req.headers, body });
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const mm = url.match(/^\/v1\/media\/([^/?]+)$/);
    if (mm) {
      res.writeHead(200, { "Content-Type": "image/webp" });
      return fs.createReadStream(path.join(mediaDir, "x.webp")).pipe(res);
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { detail: "API key 无效" });
    if (url === "/v1/images/tasks" && req.method === "POST") {
      posts++;
      if (opts.rateLimitFirst && posts <= opts.rateLimitFirst) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        return res.end(JSON.stringify({ detail: "Image queue is full" }));
      }
      const idemKey = String(req.headers["idempotency-key"] ?? "");
      const known = idemKey ? byKey.get(idemKey) : undefined;
      if (known) {
        if (known.bodyRaw !== raw) return send(409, { detail: "Idempotency-Key reused with different body" });
        return send(202, { id: known.id, task_id: known.id, status: "queued", progress: 0 });
      }
      const id = `img_${++seq}`;
      tasks.set(id, { id, polls: 0, prompt: String(body?.prompt ?? ""), attempts: 0 });
      if (idemKey) byKey.set(idemKey, { bodyRaw: raw, id });
      if (opts.dropResponseFirst && posts <= opts.dropResponseFirst) {
        req.socket.destroy();
        return;
      }
      return send(202, { id, task_id: id, status: "queued", progress: 0 });
    }
    const tm = url.match(/^\/v1\/images\/tasks\/([^/?]+)$/);
    if (tm && req.method === "GET") {
      const t = tasks.get(decodeURIComponent(tm[1]!));
      if (!t) return send(404, { detail: "task 不存在" });
      t.polls++;
      if (opts.never) return send(200, { id: t.id, status: "processing", progress: 30 });
      if (t.prompt.includes("[timeout]")) return send(200, { id: t.id, status: "failed", progress: 40, error: "timeout 超时, chờ quá lâu" });
      if (t.prompt.includes("[policy]")) return send(200, { id: t.id, status: "failed", progress: 40, error: "Nội dung bị từ chối theo policy" });
      if (t.prompt.includes("[flaky]")) {
        const n = (failCounts.get(t.prompt) ?? 0) + 1;
        failCounts.set(t.prompt, n);
        if (n <= 1) return send(200, { id: t.id, status: "failed", progress: 40, error: "timeout 超时" });
      }
      if (t.polls <= (opts.processingPolls ?? 1)) return send(200, { id: t.id, status: "processing", progress: 20 + t.polls * 20 });
      const u = opts.relativeUrl ? `/v1/media/x.webp` : `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/media/x.webp`;
      return send(200, { id: t.id, status: "completed", progress: 100, url: u, result: { filename: "x.webp", size: "1:1", kind: "image" } });
    }
    return send(404, { detail: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push(server);
  const posted = () => requests.filter((r) => r.method === "POST" && r.url === "/v1/images/tasks");
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    key: KEY,
    requests,
    tasks,
    posted,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function setup(name: string, fakeOpts: FakeOpts = {}, provOpts: { maxConcurrency?: number } = {}) {
  const env = await createEnv(name);
  envs.push(env);
  const c = await userClient(env, name.replace(/[^a-z]/g, "") + "u");
  const fake = await fakeImageApi(env, fakeOpts);
  const apiKey = fake.key;
  const prov = (await c.post("/api/providers", { providerType: "muse2api", name: "Muse thử", endpoint: fake.endpoint, apiKey, maxConcurrency: provOpts.maxConcurrency ?? 3, requestsPerMinute: 1000, options: { pollIntervalMs: 100 } })).body;
  return { env, c, fake, prov };
}

async function createImageBatch(c: Client, providerConfigId: string, prompts: string[], extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return c.post("/api/batches", { kind: "image", mode: "list", providerConfigId, config: { aspectRatio: "1:1", variantsPerPrompt: 1, ...config }, prompts: prompts.map((p) => ({ prompt: p })), maxConcurrency: 3, ...extra });
}

async function approve(c: Client, id: string, extra: Record<string, unknown> = {}) {
  return c.post(`/api/batches/${id}/approve`, { confirm: true, acknowledgeUnknownCost: true, ...extra });
}

const jobsOf = async (c: Client, id: string): Promise<any[]> => (await c.get(`/api/jobs?batchId=${id}`)).body.jobs.sort((a: any, b: any) => a.seq - b.seq);
const waitDone = (c: Client, id: string, timeoutMs = 60_000) =>
  waitFor(async () => (await c.get(`/api/batches/${id}`)).body, (b: any) => b.status === "completed" || b.status === "cancelled", timeoutMs, 100);

// ---------------------------------------------------------------- 1. tạo batch

test("ảnh: tạo batch (đơn/danh sách/file) = prompt × biến thể, kind=image, chờ duyệt, không gọi provider, không lẫn danh sách video", async () => {
  const { env, c, fake, prov } = await setup("imgcreate");
  const r = await createImageBatch(c, prov.id, ["Chai serum trên đá cẩm thạch", "Hộp kem trên nền hồng pastel", "Lọ nước hoa bên cửa sổ"], { name: "Ảnh thử" }, { aspectRatio: "4:5", variantsPerPrompt: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.batch.kind, "image");
  assert.equal(r.body.batch.status, "awaiting_approval");
  assert.equal(r.body.batch.modelId, "muse-image");
  assert.equal(r.body.batch.config.variantsPerPrompt, 2);
  assert.equal(r.body.check.jobCount, 6);
  assert.match(r.body.check.summary, /3 prompt × 2 ảnh → 6 ảnh/);
  assert.equal(r.body.estimate.kind, "unknown");
  assert.equal(r.body.estimate.imageCount, 6);
  const jobs = await jobsOf(c, r.body.batch.id);
  assert.equal(jobs.length, 6);
  assert.ok(jobs.every((j) => j.kind === "image" && j.status === "awaiting_approval" && j.config.aspectRatio === "4:5"));
  assert.equal(fake.posted().length, 0, "tạo batch KHÔNG gọi provider");

  // Danh sách batch: mặc định video (không lẫn), kind=image / all
  assert.equal((await c.get("/api/batches")).body.batches.filter((b: any) => b.kind === "image").length, 0);
  assert.equal((await c.get("/api/batches?kind=image")).body.batches.length, 1);
  assert.equal((await c.get("/api/batches?kind=all")).body.batches.length, 1);

  // Ước tính (không tạo)
  const est = await c.post("/api/batches/estimate", { kind: "image", providerConfigId: prov.id, config: { aspectRatio: "9:16", variantsPerPrompt: 3 }, prompts: [{ prompt: "A" }, { prompt: "B" }], maxConcurrency: 3 });
  assert.equal(est.status, 200);
  assert.equal(est.body.check.jobCount, 6);
  assert.equal(est.body.estimate.imageCount, 6);
  assert.ok(est.body.estimate.notes.some((n: string) => /40 giây/.test(n)));

  // Bộ prompt nhập từ file (txt) → bộ prompt → deploy thành batch ảnh
  const set = await c.post("/api/prompt-sets", { text: "Ảnh sản phẩm 1\nẢnh sản phẩm 2\nẢnh sản phẩm 3", fileName: "p.txt", name: "Từ file" });
  assert.equal(set.status, 200);
  const dep = await c.post(`/api/prompt-sets/${set.body.id}/deploy`, { providerConfigId: prov.id, config: { aspectRatio: "16:9", variantsPerPrompt: 1 }, selection: "all" });
  // Bộ prompt nhập tay không mang kind=image → deploy theo đường video bị từ chối vì muse-image không phải model video
  assert.notEqual(dep.status, 500);
  void env;
});

test("ảnh: AI viết prompt ảnh (≤10, không thời lượng/chuyển động) → duyệt → triển khai thành batch ảnh", async () => {
  const { c, prov, env } = await setup("imgai");
  const seen: string[] = [];
  const llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const system = String(body.messages?.find((m: any) => m.role === "system")?.content ?? "");
      const user = String(body.messages?.filter((m: any) => m.role === "user").pop()?.content ?? "");
      seen.push(system + "\n" + user);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (system.includes("TẠO ẢNH AI")) {
        const u = JSON.parse(user);
        const items = u.slots.map((s: any) => ({ slot: s.slot, title: `Ảnh ${s.slot}`, objective: "bán hàng", prompt: `Ảnh ${s.slot}: chai ${s.genre} góc ${s.angle}, bối cảnh ${s.setting}, phong cách ${s.style}, mã ${s.slot * 13}`, negative: "", genre: s.genre }));
        return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ items }) } }] }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ title: "Viết lại", objective: "mới", prompt: "Phiên bản viết lại: chai nước trên nền trắng, ánh sáng mềm" }) } }] }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", () => r()));
  servers.push(llm);
  await c.req("PUT", "/api/settings/llm", { baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, textModel: "fake-text", visionModel: "fake-vision" });

  const g = await c.post("/api/prompt-sets/generate", { kind: "image", count: 4, aspectRatio: "9:16", providerConfigId: prov.id, modelId: "muse-image", brief: "Quảng cáo chai nước" });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.generated, 4);
  assert.ok(g.body.set.items.every((i: any) => i.durationSec === null && i.aspectRatio === "9:16"), "prompt ảnh không có thời lượng");
  assert.ok(seen.some((s) => s.includes("TẠO ẢNH AI") && !s.includes("TẠO VIDEO")));
  assert.ok(!seen.join("\n").includes("duration"), "không đòi thời lượng khi viết prompt ảnh");

  // Quá 10 → lỗi tiếng Việt
  const over = await c.post("/api/prompt-sets/generate", { kind: "image", count: 11, aspectRatio: "1:1", providerConfigId: prov.id, modelId: "muse-image" });
  assert.equal(over.status, 400);
  assert.equal(over.body.error.code, "INVALID_COUNT");
  const badRatio = await c.post("/api/prompt-sets/generate", { kind: "image", count: 2, aspectRatio: "21:9", providerConfigId: prov.id, modelId: "muse-image" });
  assert.equal(badRatio.body.error.code, "INVALID_ASPECT");

  // Viết lại 1 prompt ảnh dùng system ảnh
  const rw = await c.post(`/api/prompt-items/${g.body.set.items[0].id}/rewrite`, { instruction: "ngắn hơn", providerConfigId: prov.id, modelId: "muse-image" });
  assert.equal(rw.status, 200, JSON.stringify(rw.body));
  assert.match(rw.body.prompt, /viết lại/);

  // Duyệt → triển khai (dryRun rồi thật)
  await c.post(`/api/prompt-sets/${g.body.set.id}/approval`, { itemIds: "all", approval: "approved" });
  const dry = await c.post(`/api/prompt-sets/${g.body.set.id}/deploy`, { dryRun: true, providerConfigId: prov.id, config: { variantsPerPrompt: 2, aspectRatio: "9:16" } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.videoCount, 8);
  const dep = await c.post(`/api/prompt-sets/${g.body.set.id}/deploy`, { providerConfigId: prov.id, config: { variantsPerPrompt: 2, aspectRatio: "9:16" } });
  assert.equal(dep.status, 200, JSON.stringify(dep.body));
  assert.equal(dep.body.batch.kind, "image");
  assert.equal((await jobsOf(c, dep.body.batch.id)).length, 8);
  assert.equal(dep.body.batch.status, "awaiting_approval");
  void env;
});

// ---------------------------------------------------------------- 2. validate

test("ảnh: validate cấu hình → lỗi tiếng Việt, ≥30 ảnh cần confirmLarge, provider video-only bị từ chối", async () => {
  const { env, c, fake, prov } = await setup("imgvalid");
  const bad = async (cfg: Record<string, unknown>, extra: Record<string, unknown> = {}) => createImageBatch(c, prov.id, ["Một prompt"], extra, cfg);

  let r = await bad({ aspectRatio: "21:9" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "INVALID_ASPECT");
  assert.match(r.body.error.message, /Tỉ lệ khung hình/);
  for (const v of [0, 5]) {
    r = await bad({ variantsPerPrompt: v });
    assert.equal(r.body.error.code, "INVALID_VARIANTS", `variants ${v}`);
  }
  r = await bad({ referenceAssetIds: ["a", "b"] });
  assert.equal(r.body.error.code, "TOO_MANY_REFERENCES");
  for (const n of [0, 7]) {
    r = await bad({}, { maxConcurrency: n });
    assert.equal(r.body.error.code, "INVALID_CONCURRENCY", `luồng ${n}`);
  }
  r = await createImageBatch(c, prov.id, []);
  assert.equal(r.body.error.code, "NO_PROMPTS");
  r = await createImageBatch(c, prov.id, ["x".repeat(2100)]);
  assert.equal(r.status, 422, "prompt quá dài bị chặn trước khi gọi provider");
  // Prompt trùng bị báo
  r = await createImageBatch(c, prov.id, ["Trùng nhau hoàn toàn", "Trùng nhau hoàn toàn"]);
  assert.equal(r.status, 422);
  // Mock provider không làm được ảnh
  r = await createImageBatch(c, mockProviderId(env, c.workspaceId), ["Ảnh"]);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "IMAGE_PROVIDER_UNSUPPORTED");
  assert.equal(fake.posted().length, 0);

  // 30 ảnh → bắt buộc confirmLarge; 29 ảnh thì không
  const many = await createImageBatch(c, prov.id, Array.from({ length: 10 }, (_, i) => `Ảnh số ${i} khác nhau ${i * 17}`), {}, { variantsPerPrompt: 3 });
  assert.equal(many.status, 200);
  const noLarge = await approve(c, many.body.batch.id);
  assert.equal(noLarge.status, 409);
  assert.equal(noLarge.body.error.code, "LARGE_BATCH_CONFIRM_REQUIRED");
  assert.match(noLarge.body.error.message, /30 ảnh/);
  assert.equal(noLarge.body.error.details.imageCount, 30);
  const ok = await approve(c, many.body.batch.id, { confirmLarge: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, "running");

  const small = await createImageBatch(c, prov.id, Array.from({ length: 9 }, (_, i) => `Ảnh nhỏ ${i} riêng ${i * 31}`), {}, { variantsPerPrompt: 3 });
  assert.equal((await approve(c, small.body.batch.id)).status, 200, "27 ảnh không cần confirmLarge");
  // Chưa có worker → vẫn chưa gọi provider
  assert.equal(fake.posted().length, 0);
});

// ---------------------------------------------------------------- 3. provider + 6. lưu file

test("ảnh: provider gọi đúng /v1/images/tasks (body, Idempotency-Key), đọc url tuyệt đối & tương đối, lưu webp + thumbnail vào kho, không vào hàng đăng Reels", async () => {
  for (const relativeUrl of [false, true]) {
    const { env, c, fake, prov } = await setup(relativeUrl ? "imgrel" : "imgrun", { processingPolls: 2, relativeUrl });
    // Ảnh tham chiếu (tải lên như asset ảnh)
    const refPath = path.join(env.dir, "ref.png");
    await run(env.ctx.media.ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", refPath]);
    const ref = await env.ctx.storage.ingestFile({ workspaceId: c.workspaceId, sessionId: null, tmpPath: refPath, fileName: "ref.png", kind: "image", origin: "upload", createdBy: null, folder: "refs" });

    const r = await createImageBatch(c, prov.id, ["Chai serum nền đá", "Hộp kem nền hồng"], { name: "Chạy thật" }, { aspectRatio: "9:16", referenceAssetIds: [ref.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.batch.id;
    assert.equal((await approve(c, id)).status, 200);
    env.startWorker();
    const done = await waitDone(c, id);
    assert.equal(done.counts.completed, 2);

    const posts = fake.posted();
    assert.equal(posts.length, 2, "mỗi ảnh đúng 1 task");
    const jobs = await jobsOf(c, id);
    for (const p of posts) {
      assert.equal(p.headers.authorization, `Bearer ${fake.key}`);
      assert.equal(p.body.model, "muse-image");
      assert.equal(p.body.aspect_ratio, "9:16");
      assert.equal(p.body.size, "9:16");
      assert.equal(p.body.timeout, 300);
      assert.match(String(p.body.reference_image), /^data:image\/png;base64,/);
      assert.ok(jobs.some((j) => p.headers["idempotency-key"] === `${j.id}#1`), "Idempotency-Key = jobId#attempt");
    }
    assert.ok(fake.requests.some((q) => q.method === "GET" && /^\/v1\/images\/tasks\/img_\d+$/.test(q.url)));
    assert.ok(!fake.requests.some((q) => q.url.startsWith("/v1/videos")), "không đụng endpoint video");

    // File nằm trong kho BVS, không phụ thuộc link tạm
    await fake.close();
    for (const j of jobs) {
      const a = env.ctx.db.get<any>("SELECT * FROM video_assets WHERE id = ?", j.outputAssetId)!;
      assert.equal(a.kind, "image");
      assert.equal(a.origin, "provider");
      assert.equal(a.source_job_id, j.id);
      assert.match(a.file_name, /\.webp$/);
      assert.ok(fs.existsSync(env.ctx.storage.abs(a.storage_path)));
      assert.ok(a.size_bytes > 0);
      assert.match(a.thumbnail_path, /thumb\.jpg$/, "có bản xem trước nhỏ");
      assert.ok(fs.existsSync(env.ctx.storage.abs(a.thumbnail_path)));
      assert.ok(!a.storage_path.includes("http"));
      assert.equal((await c.get(`/api/assets/${j.outputAssetId}/file`)).status, 200);
      assert.equal((await c.get(`/api/assets/${j.outputAssetId}/thumbnail`)).status, 200);
      assert.ok(j.output.thumbnail);
    }
    assert.equal(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM fb_reel_posts")!.n, 0, "ảnh không vào hàng đăng Facebook");
  }
});

// ---------------------------------------------------------------- 4. lỗi / retry

test("ảnh: 429 & timeout được thử lại tới maxAttempts rồi failed; policy không thử lại; chạy lại ảnh lỗi", async () => {
  const { env, c, fake, prov } = await setup("imgretry", { processingPolls: 0 });
  const r = await createImageBatch(c, prov.id, ["Ảnh bình thường", "Ảnh [policy] bị từ chối", "Ảnh [timeout] luôn quá hạn", "Ảnh [flaky] lỗi lần đầu"], {}, { maxAttempts: 2 });
  const id = r.body.batch.id;
  await approve(c, id);
  env.startWorker();
  const done = await waitDone(c, id, 90_000);
  assert.equal(done.status, "completed");
  const jobs = await jobsOf(c, id);
  const [normal, policy, timeout, flaky] = jobs;
  assert.equal(policy.status, "failed");
  assert.equal(policy.attempt, 1, "policy không thử lại");
  assert.equal(policy.error.code, "CONTENT_POLICY");
  assert.equal(timeout.status, "failed");
  assert.equal(timeout.attempt, 2, "timeout thử tới maxAttempts=2");
  assert.equal(timeout.maxAttempts, 2);
  assert.equal(flaky.status, "completed");
  assert.equal(flaky.attempt, 2, "lỗi tạm thời → tạo lại 1 lần");
  assert.equal(normal.status, "completed");
  assert.equal(fake.posted().length, 6, "4 ảnh + 2 lần tạo lại (timeout, flaky)");
  const ev = (await c.get(`/api/jobs/${timeout.id}/events`)).body.events;
  assert.ok(ev.some((e: any) => e.to === "queued"), "có sự kiện xếp lại hàng đợi");

  // Chạy lại ảnh lỗi (muse2api không tính tiền → confirm + acknowledgeUnknownCost)
  assert.equal((await c.post(`/api/batches/${id}/retry-failed`, {})).body.error.code, "CONFIRMATION_REQUIRED");
  assert.equal((await c.post(`/api/batches/${id}/retry-failed`, { confirm: true })).body.error.code, "COST_UNKNOWN_ACK_REQUIRED");
  const retry = await c.post(`/api/batches/${id}/retry-failed`, { confirm: true, acknowledgeUnknownCost: true });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.retried.length, 2);
  await waitFor(async () => (await jobsOf(c, id)).map((j) => j.status), (s) => s.every((x: string) => x === "failed" || x === "completed") && (s.filter((x: string) => x === "failed").length === 2), 60_000);
});

test("ảnh: 429 \"Image queue is full\" được backoff gửi lại; quá maxAttempts thì failed RATE_LIMIT", async () => {
  const a = await setup("img429a", { processingPolls: 0, rateLimitFirst: 2 });
  const r1 = await createImageBatch(a.c, a.prov.id, ["Ảnh gặp 429"], {}, { maxAttempts: 3 });
  await approve(a.c, r1.body.batch.id);
  a.env.startWorker();
  await waitDone(a.c, r1.body.batch.id, 60_000);
  const j1 = (await jobsOf(a.c, r1.body.batch.id))[0];
  assert.equal(j1.status, "completed");
  assert.equal(j1.attempt, 3, "2 lần 429 rồi thành công");
  assert.equal(a.fake.tasks.size, 1, "429 chưa tạo task nên không trùng ảnh");

  const b = await setup("img429b", { processingPolls: 0, rateLimitFirst: 99 });
  const r2 = await createImageBatch(b.c, b.prov.id, ["Ảnh luôn 429"], {}, { maxAttempts: 2 });
  await approve(b.c, r2.body.batch.id);
  b.env.startWorker();
  await waitDone(b.c, r2.body.batch.id, 60_000);
  const j2 = (await jobsOf(b.c, r2.body.batch.id))[0];
  assert.equal(j2.status, "failed");
  assert.equal(j2.error.code, "RATE_LIMIT");
  assert.equal(j2.attempt, 2);
});

// ---------------------------------------------------------------- 5. không tạo trùng khi khởi động lại

test("ảnh: restart giữa chừng không tạo trùng (job processing được poll tiếp; job submitting gửi lại ĐÚNG key cũ; mất phản hồi → cùng key)", async () => {
  // a) processing + scheduler mới (mô phỏng restart)
  {
    const { env, c, fake, prov } = await setup("imgrestart", { processingPolls: 3 });
    const r = await createImageBatch(c, prov.id, ["Ảnh restart A", "Ảnh restart B", "Ảnh restart C"]);
    const id = r.body.batch.id;
    await approve(c, id);
    const s1 = new Scheduler(env.ctx, { log: () => {}, pollIntervalMs: 100, leaseMs: 200 });
    await s1.tick(); // gửi cả 3
    assert.equal(fake.posted().length, 3);
    assert.ok((await jobsOf(c, id)).every((j) => j.status === "processing" && j.remoteJobId));
    // "Restart": bỏ s1, lease hết hạn, scheduler mới nhặt tiếp
    await new Promise((r2) => setTimeout(r2, 300));
    const s2 = new Scheduler(env.ctx, { log: () => {}, pollIntervalMs: 100, leaseMs: 5000 });
    for (let i = 0; i < 80; i++) {
      await s2.tick();
      if ((await c.get(`/api/batches/${id}`)).body.status === "completed") break;
      await new Promise((r2) => setTimeout(r2, 60));
    }
    const done = (await c.get(`/api/batches/${id}`)).body;
    assert.equal(done.counts.completed, 3);
    assert.equal(fake.posted().length, 3, "không POST lại job đã processing");
    assert.equal(fake.tasks.size, 3);
    assert.equal(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_assets WHERE kind = 'image' AND origin = 'provider'")!.n, 3);
  }
  // b) job kẹt ở submitting (worker chết giữa lúc gửi) → xếp lại, gửi lại đúng key
  {
    const { env, c, fake, prov } = await setup("imgsubmitting", { processingPolls: 0 });
    const r = await createImageBatch(c, prov.id, ["Ảnh kẹt submitting"]);
    const id = r.body.batch.id;
    await approve(c, id);
    const job = (await jobsOf(c, id))[0];
    env.ctx.db.run("UPDATE video_batch_jobs SET status = 'submitting', attempt = 1, idempotency_key = ?, lease_owner = 'chet', lease_until = ? WHERE id = ?", `${job.id}#1`, Date.now() - 1000, job.id);
    const s = new Scheduler(env.ctx, { log: () => {}, pollIntervalMs: 100 });
    for (let i = 0; i < 60; i++) {
      await s.tick();
      if ((await c.get(`/api/batches/${id}`)).body.status === "completed") break;
      await new Promise((r2) => setTimeout(r2, 60));
    }
    const j = (await jobsOf(c, id))[0];
    assert.equal(j.status, "completed");
    assert.equal(j.attempt, 1, "không tăng lượt thử");
    assert.equal(fake.posted().length, 1);
    assert.equal(fake.posted()[0]!.headers["idempotency-key"], `${job.id}#1`, "gửi lại đúng key cũ");
  }
  // c) POST tới nơi nhưng mất phản hồi → gửi lại cùng key, muse2api trả task cũ → chỉ 1 ảnh
  {
    const { env, c, fake, prov } = await setup("imgdrop", { processingPolls: 0, dropResponseFirst: 1 });
    const r = await createImageBatch(c, prov.id, ["Ảnh mất phản hồi"]);
    const id = r.body.batch.id;
    await approve(c, id);
    env.startWorker();
    const done = await waitDone(c, id, 60_000);
    assert.equal(done.counts.completed, 1);
    assert.equal(fake.posted().length, 2, "gửi lại sau khi mất phản hồi");
    assert.equal(fake.tasks.size, 1, "muse2api chỉ tạo 1 ảnh nhờ Idempotency-Key");
    const keys = new Set(fake.posted().map((p) => p.headers["idempotency-key"]));
    assert.equal(keys.size, 1, "cùng một key");
  }
});

// ---------------------------------------------------------------- 7-8. thư viện + ZIP

test("ảnh: Thư viện lọc theo loại (mặc định video không đổi), ZIP cả batch, 404 khi rỗng, xoá asset/batch", async () => {
  const { env, c, fake, prov } = await setup("imglib", { processingPolls: 0 });
  const empty = await createImageBatch(c, prov.id, ["Batch chưa chạy"]);
  const z0 = await c.get(`/api/batches/${empty.body.batch.id}/zip`);
  assert.equal(z0.status, 404);
  assert.equal(z0.body.error.code, "BATCH_EMPTY");
  assert.match(z0.body.error.message, /chưa có ảnh nào/);

  const r = await createImageBatch(c, prov.id, ["Thư viện 1", "Thư viện 2", "Thư viện 3"], { name: "Bộ ảnh ZIP" });
  const id = r.body.batch.id;
  await approve(c, id);
  env.startWorker();
  await waitDone(c, id);
  await env.stopWorker();
  assert.equal(fake.posted().length, 3);

  // Có thêm 1 video do mock tạo để chứng minh lọc
  const mock = mockProviderId(env, c.workspaceId);
  tuneMock(env, mock, { latencyMs: 50, maxConcurrency: 2, rpm: 1000 });
  env.startWorker();
  const vb = await c.post("/api/batches", { mode: "list", providerConfigId: mock, modelId: "mock-standard", config: { durationSec: 4, aspectRatio: "9:16", resolution: "480p", audio: false }, prompts: [{ prompt: "Video đối chứng" }], maxConcurrency: 1 });
  await c.post(`/api/batches/${vb.body.batch.id}/approve`, { confirm: true });
  await waitDone(c, vb.body.batch.id);
  await env.stopWorker();

  const def = (await c.get("/api/library")).body.items;
  assert.equal(def.length, 1, "mặc định chỉ video như cũ");
  assert.equal(def[0].kindOf, "video");
  const imgs = (await c.get("/api/library?kind=image")).body.items;
  assert.equal(imgs.length, 3);
  assert.ok(imgs.every((i: any) => i.kindOf === "image" && i.batchId === id && /^Thư viện/.test(i.prompt) && i.aspectRatio === "1:1"));
  assert.equal((await c.get("/api/library?kind=all")).body.items.length, 4);
  assert.equal((await c.get("/api/batches")).body.batches.length, 1, "danh sách batch video không lẫn batch ảnh");

  // ZIP batch ảnh
  const z = await c.get(`/api/batches/${id}/zip`);
  assert.equal(z.status, 200);
  assert.match(String(z.headers.get("content-type")), /application\/zip/);
  assert.match(decodeURIComponent(String(z.headers.get("content-disposition"))), /anh-Bộ-ảnh-ZIP-\d+\.zip/);
  let entries = 0;
  for (let i = 0; i + 4 <= z.raw.length; i++) if (z.raw.readUInt32LE(i) === 0x04034b50) entries++;
  assert.equal(entries, 3, "ZIP có đúng 3 file ảnh");
  assert.equal(z.raw.subarray(0, 2).toString(), "PK");

  // ZIP chọn tay từ Thư viện
  const sel = await c.post("/api/assets/zip", { assetIds: imgs.slice(0, 2).map((i: any) => i.id) });
  assert.equal(sel.status, 200);

  // Xoá 1 ảnh
  const del = await c.post("/api/assets/delete", { assetIds: [imgs[0].id] });
  assert.equal(del.body.deleted.length, 1);
  assert.equal((await c.get("/api/library?kind=image")).body.items.length, 2);
  assert.equal(fs.existsSync(env.ctx.storage.abs(env.ctx.db.get<any>("SELECT storage_path FROM video_assets WHERE id = ?", imgs[1].id)!.storage_path)), true);

  // Xoá cả batch → xoá luôn ảnh
  const delB = await c.req("DELETE", `/api/batches/${id}`);
  assert.equal(delB.status, 200, JSON.stringify(delB.body));
  assert.equal((await c.get("/api/library?kind=image")).body.items.length, 0);
  assert.equal((await c.get("/api/library")).body.items.length, 1, "video đối chứng còn nguyên");
});

// ---------------------------------------------------------------- 9. huỷ

test("ảnh: huỷ batch/job chưa gửi được; ảnh đã gửi → CANCEL_UNSUPPORTED; ảnh chờ quá lâu → timeout rồi failed", async () => {
  const { env, c, fake, prov } = await setup("imgcancel", { never: true }, { maxConcurrency: 1 });
  const r = await createImageBatch(c, prov.id, ["Huỷ A", "Huỷ B", "Huỷ C"], {}, { maxAttempts: 1 });
  const id = r.body.batch.id;

  // Huỷ job lẻ trước khi duyệt
  const jobs0 = await jobsOf(c, id);
  const one = await c.post(`/api/jobs/${jobs0[2].id}/cancel`, {});
  assert.equal(one.body.cancelled, true);

  await approve(c, id);
  const s = new Scheduler(env.ctx, { log: () => {}, pollIntervalMs: 100 });
  await s.tick(); // provider chỉ 1 slot → 1 ảnh được gửi
  const jobs = await jobsOf(c, id);
  const processing = jobs.find((j) => j.status === "processing")!;
  assert.ok(processing);
  assert.equal(fake.posted().length, 1);
  const cu = await c.post(`/api/jobs/${processing.id}/cancel`, {});
  assert.equal(cu.status, 409);
  assert.equal(cu.body.error.code, "CANCEL_UNSUPPORTED");

  const pend = await c.post(`/api/batches/${id}/cancel-pending`, {});
  assert.equal(pend.body.cancelled, 1, "chỉ huỷ ảnh chưa gửi (Huỷ B)");
  assert.equal((await jobsOf(c, id)).filter((j) => j.status === "cancelled").length, 2);
  assert.equal(fake.posted().length, 1, "huỷ không gửi thêm gì");

  // Chờ quá imageMaxWaitSec → TIMEOUT (maxAttempts=1 → failed)
  env.ctx.providers.update(c.workspaceId, prov.id, { options: { pollIntervalMs: 100, imageMaxWaitSec: 1 } });
  await new Promise((r2) => setTimeout(r2, 1300));
  for (let i = 0; i < 10; i++) {
    await s.tick();
    if ((await jobsOf(c, id)).find((j) => j.id === processing.id)!.status === "failed") break;
    await new Promise((r2) => setTimeout(r2, 150));
  }
  const failed = (await jobsOf(c, id)).find((j) => j.id === processing.id)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "TIMEOUT");
});

// ---------------------------------------------------------------- tool MCP

test("ảnh: tool video_create_image_batch tạo batch CHỜ DUYỆT (không chạy), approve truyền confirmLarge", async () => {
  const { env, c, fake, prov } = await setup("imgtool");
  const { invokeTool } = await import("../src/tools.ts");
  const userId = env.ctx.db.get<{ id: string }>("SELECT user_id AS id FROM workspace_members WHERE workspace_id = ?", c.workspaceId)?.id ?? "u";
  const out: any = await invokeTool(env.ctx, { workspaceId: c.workspaceId, userId, channel: "mcp" }, "video_create_image_batch", { prompts: ["Tool ảnh 1", "Tool ảnh 2"], aspectRatio: "3:4", variantsPerPrompt: 2, providerConfigId: prov.id });
  assert.equal(out.status, "awaiting_approval");
  assert.match(out.summary, /2 prompt × 2 ảnh → 4 ảnh/);
  assert.equal(fake.posted().length, 0);
  const b = (await c.get(`/api/batches/${out.batchId}`)).body;
  assert.equal(b.kind, "image");
  assert.equal(b.config.aspectRatio, "3:4");
  await assert.rejects(() => invokeTool(env.ctx, { workspaceId: c.workspaceId, userId, channel: "mcp" }, "video_create_image_batch", { prompts: ["x"], variantsPerPrompt: 9 }), /variantsPerPrompt/);
});
