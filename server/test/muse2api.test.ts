import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createEnv, userClient, waitBatchDone, waitFor, type TestEnv } from "./helpers.ts";
import { renderMockVideo } from "../src/media.ts";
import { mapMuseTask } from "../src/providers/muse2api.ts";

/**
 * Adapter muse2api chạy với MÁY CHỦ GIẢ dựng theo đúng mã nguồn app.py của
 * muse2api (đọc 2026-10-16) - KHÔNG gọi muse.ai, KHÔNG cần tài khoản Muse,
 * KHÔNG tiêu hạn mức.
 *
 * Khuôn được giả lập:
 *   GET  /v1/models                 (cần Bearer)
 *   GET  /readyz                    (không cần key)
 *   POST /v1/videos                 → {id, task_id, status:"queued", progress:10}
 *   GET  /v1/videos/{id}            → status queued|processing|completed|failed + progress + url
 *   GET  /v1/media/{name}           → file mp4, KHÔNG đòi Authorization
 */
const envs: TestEnv[] = [];
const servers: http.Server[] = [];
after(async () => {
  for (const e of envs) await e.close().catch(() => {});
  for (const s of servers) await new Promise((r) => s.close(r));
});

interface FakeOpts {
  key?: string;
  accounts?: number;
  /** Số lần poll trả "processing" trước khi xong */
  processingPolls?: number;
  /** Cho task thất bại với thông điệp này */
  failWith?: string;
  /** media_url trả đường dẫn tương đối (MUSE2API_PUBLIC_BASE trống) */
  relativeMediaUrl?: boolean;
  /** Trả 429 cho N request POST đầu */
  rateLimitFirst?: number;
}

async function fakeMuse2Api(env: TestEnv, opts: FakeOpts = {}) {
  const key = opts.key ?? "m2a_test_key_abcdef";
  const requests: { method: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const tasks = new Map<string, { id: string; polls: number; filename: string }>();
  const mediaDir = path.join(env.dir, "fake-muse-media");
  fs.mkdirSync(mediaDir, { recursive: true });
  let seq = 0;
  let posts = 0;

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
    requests.push({ method: req.method ?? "", url, headers: req.headers as Record<string, string>, body });
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // /v1/media KHÔNG kiểm key (đúng app.py: get_media không có Depends(auth))
    const mediaMatch = url.match(/^\/v1\/media\/([^/?]+)$/);
    if (mediaMatch) {
      const f = path.join(mediaDir, decodeURIComponent(mediaMatch[1]!));
      if (!fs.existsSync(f)) return send(404, { detail: "文件不存在" });
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(fs.statSync(f).size) });
      return fs.createReadStream(f).pipe(res);
    }
    if (url === "/readyz") return send(200, { status: (opts.accounts ?? 1) > 0 ? "ready" : "no_account", accounts: opts.accounts ?? 1, browser_running: true });
    // Mọi route còn lại đòi Bearer
    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { detail: "API key 无效" });
    if (url === "/v1/models") return send(200, { object: "list", data: [{ id: "muse-video", object: "model", owned_by: "muse" }] });
    if (url === "/v1/videos" && req.method === "POST") {
      posts++;
      if (opts.rateLimitFirst && posts <= opts.rateLimitFirst) {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        return res.end(JSON.stringify({ detail: "队列已满" }));
      }
      const id = `task_${++seq}`;
      const filename = `vid_${id}.mp4`;
      tasks.set(id, { id, polls: 0, filename });
      // Video thật để BVS ingest được (ffprobe phải thấy luồng hình)
      await renderMockVideo(env.ctx.media, path.join(mediaDir, filename), { durationSec: 2, aspect: "9:16", label: id, withAudio: false });
      return send(200, { id, task_id: id, object: "video.task", status: "queued", progress: 10, created_at: Date.now() / 1000 });
    }
    const vm = url.match(/^\/v1\/videos\/([^/?]+)$/);
    if (vm && req.method === "GET") {
      const t = tasks.get(decodeURIComponent(vm[1]!));
      if (!t) return send(404, { detail: "task 不存在" });
      t.polls++;
      if (opts.failWith) return send(200, { id: t.id, status: "failed", progress: 40, error: opts.failWith });
      if (t.polls <= (opts.processingPolls ?? 1)) return send(200, { id: t.id, status: "processing", progress: 15 + t.polls * 10 });
      const u = opts.relativeMediaUrl ? `/v1/media/${t.filename}` : `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/media/${t.filename}`;
      return send(200, { id: t.id, status: "completed", progress: 100, url: u, video: { url: u }, result: { url: u, filename: t.filename, bytes: 1234, kind: "video" } });
    }
    return send(404, { detail: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, key, requests, tasks, mediaDir };
}

test("muse2api: khai năng lực đúng (không tính phí theo request nhưng KHÔNG phải free-mock, không hủy, không idempotency)", async () => {
  const env = await createEnv("m2a-caps");
  envs.push(env);
  const c = await userClient(env, "caps");
  const fake = await fakeMuse2Api(env);

  const created = await c.post("/api/providers", { providerType: "muse2api", name: "Muse thử", endpoint: fake.endpoint, apiKey: fake.key });
  assert.equal(created.status, 200);
  const caps = created.body.capabilities;

  // Quan trọng nhất: KHÔNG được khai free-mock, nếu không chat/agent sẽ tự duyệt chạy và đốt hạn mức
  assert.equal(caps.pricing, "unknown", "phải là unknown để BVS vẫn buộc người dùng duyệt");
  assert.equal(caps.cancel, "none", "muse2api không có endpoint hủy video");
  assert.equal(caps.idempotency, false, "không gửi lại cùng key → tránh tạo trùng, tiêu hạn mức 2 lần");
  assert.equal(caps.progress, true);
  assert.equal(caps.webhook, false);

  const m = caps.models.find((x: any) => x.modelId === "muse-video");
  assert.deepEqual(m.durations, { min: 3, max: 15, auto: true });
  assert.deepEqual(m.aspectRatios, ["9:16", "16:9"]);
  assert.equal(m.audio, false);
  assert.equal(m.negativePrompt, false);
  assert.equal(m.maxReferenceImages, 1);
  assert.equal(m.verified, true);

  // Ước tính: không xác định được → BVS phải đòi acknowledgeUnknownCost
  const est = await c.post("/api/batches/estimate", {
    providerConfigId: created.body.id,
    modelId: "muse-video",
    config: { durationSec: 6, aspectRatio: "9:16", resolution: "720p" },
    prompts: [{ prompt: "Chai nước xoay chậm trên nền đen" }],
    maxConcurrency: 2,
  });
  assert.equal(est.status, 200);
  assert.equal(est.body.estimate.total, null);
  assert.equal(est.body.estimate.kind, "unknown");
});

test("muse2api: thông số sai bị chặn TRƯỚC khi gọi provider (thời lượng lạ, tỷ lệ lạ, audio, negative)", async () => {
  const env = await createEnv("m2a-validate");
  envs.push(env);
  const c = await userClient(env, "valid");
  const fake = await fakeMuse2Api(env);
  const prov = (await c.post("/api/providers", { providerType: "muse2api", endpoint: fake.endpoint, apiKey: fake.key })).body;

  const bad = await c.post("/api/batches", {
    mode: "list",
    providerConfigId: prov.id,
    modelId: "muse-video",
    config: { durationSec: 40, aspectRatio: "1:1", resolution: "720p", audio: true },
    prompts: [{ prompt: "Thông số sai", negative: "mờ" }],
  });
  assert.equal(bad.status, 422);
  const codes = bad.body.error.details.items.flatMap((i: any) => i.issues.map((x: any) => x.code));
  for (const code of ["DURATION_UNSUPPORTED", "ASPECT_UNSUPPORTED", "AUDIO_UNSUPPORTED", "NEGATIVE_UNSUPPORTED"]) assert.ok(codes.includes(code), `thiếu ${code}: ${codes}`);
  assert.equal(fake.requests.filter((r) => r.method === "POST").length, 0, "KHÔNG gọi provider khi thông số sai");

  // 5/6/8/10/15 giây thì qua
  for (const d of [5, 6, 8, 10]) {
    const ok = await c.post("/api/batches/estimate", { providerConfigId: prov.id, modelId: "muse-video", config: { durationSec: d, aspectRatio: "16:9", resolution: "720p" }, prompts: [{ prompt: `Video ${d} giây` }], maxConcurrency: 1 });
    assert.equal(ok.body.check.ok, true, `${d} giây phải hợp lệ`);
  }
});

test("muse2api: chạy trọn vòng submit → poll → tải video về kho; khuôn request đúng app.py", async () => {
  const env = await createEnv("m2a-run");
  envs.push(env);
  const c = await userClient(env, "run");
  const fake = await fakeMuse2Api(env, { processingPolls: 2 });
  const prov = (await c.post("/api/providers", {
    providerType: "muse2api",
    endpoint: fake.endpoint,
    apiKey: fake.key,
    maxConcurrency: 2,
    options: { pollIntervalMs: 100, extraPrompt: "phong cách điện ảnh", videoTimeoutSec: 600 },
  })).body;

  const batch = await c.post("/api/batches", {
    mode: "list",
    providerConfigId: prov.id,
    modelId: "muse-video",
    config: { durationSec: 8, aspectRatio: "9:16", resolution: "720p", audio: false },
    prompts: [{ prompt: "Chai serum trên nền đá cẩm thạch" }, { prompt: "Người mẫu cầm sản phẩm giờ vàng" }],
    maxConcurrency: 2,
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.batch.status, "awaiting_approval");
  assert.equal(fake.requests.filter((r) => r.method === "POST").length, 0, "tạo batch KHÔNG gọi provider");

  const bid = batch.body.batch.id;
  // Chi phí không xác định → duyệt phải kèm acknowledgeUnknownCost
  assert.equal((await c.post(`/api/batches/${bid}/approve`, { confirm: true })).body.error.code, "COST_UNKNOWN_ACK_REQUIRED");
  assert.equal((await c.post(`/api/batches/${bid}/approve`, { confirm: true, acknowledgeUnknownCost: true })).status, 200);

  env.startWorker();
  const done = await waitBatchDone(c, bid, 120_000);
  assert.equal(done.status, "completed");
  assert.equal(done.counts.completed, 2);

  // Khuôn body đúng VideoRequest của app.py
  const post = fake.requests.find((r) => r.method === "POST" && r.url === "/v1/videos")!;
  assert.equal(post.headers.authorization, `Bearer ${fake.key}`);
  assert.equal(post.body.model, "muse-video");
  assert.equal(post.body.duration, 8);
  assert.equal(post.body.aspect_ratio, "9:16");
  assert.equal(post.body.size, "9:16");
  assert.equal(post.body.resolution, "720p");
  assert.equal(post.body.extra, "phong cách điện ảnh");
  assert.equal(post.body.timeout, 600);
  assert.ok(!("reference_image" in post.body) || post.body.reference_image === undefined, "text-to-video không gửi ảnh");

  // Mỗi prompt đúng 1 task, không gửi trùng
  assert.equal(fake.requests.filter((r) => r.method === "POST" && r.url === "/v1/videos").length, 2);
  assert.equal(fake.tasks.size, 2);

  // Video đã chép về kho BỀN, không lưu URL
  const jobs = (await c.get(`/api/jobs?batchId=${bid}`)).body.jobs;
  assert.equal(new Set(jobs.map((j: any) => j.outputAssetId)).size, 2);
  for (const j of jobs) {
    const a = env.ctx.db.get<{ storage_path: string; size_bytes: number }>("SELECT storage_path, size_bytes FROM video_assets WHERE id = ?", j.outputAssetId)!;
    const abs = env.ctx.storage.abs(a.storage_path);
    assert.ok(fs.existsSync(abs), "file video phải nằm trong kho");
    assert.ok(a.size_bytes > 0);
    assert.ok(!a.storage_path.includes("http"));
  }
  // Tải qua API của BVS được
  const first = jobs[0].outputAssetId;
  assert.equal((await c.get(`/api/assets/${first}/file`)).status, 200);
});

test("muse2api: media_url tương đối (PUBLIC_BASE trống) vẫn tải được", async () => {
  const env = await createEnv("m2a-relative");
  envs.push(env);
  const c = await userClient(env, "rel");
  const fake = await fakeMuse2Api(env, { processingPolls: 0, relativeMediaUrl: true });
  const prov = (await c.post("/api/providers", { providerType: "muse2api", endpoint: fake.endpoint, apiKey: fake.key, options: { pollIntervalMs: 100 } })).body;
  const b = await c.post("/api/batches", { mode: "single", providerConfigId: prov.id, modelId: "muse-video", config: { durationSec: 5, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "Đường dẫn tương đối" }] });
  await c.post(`/api/batches/${b.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  env.startWorker();
  const done = await waitBatchDone(c, b.body.batch.id, 120_000);
  assert.equal(done.counts.completed, 1, "ghép base vào đường dẫn tương đối rồi tải được");
});

test("muse2api: lỗi hết hạn mức KHÔNG thử lại; lỗi mạng tạm thời thì thử lại; test kết nối không tạo video", async () => {
  const env = await createEnv("m2a-errors");
  envs.push(env);
  const c = await userClient(env, "err");

  // 1. Task thất bại vì hết hạn mức → QUOTA, không thử lại
  const quotaFake = await fakeMuse2Api(env, { failWith: "账号额度已用完 (hết hạn mức tuần)" });
  const p1 = (await c.post("/api/providers", { providerType: "muse2api", endpoint: quotaFake.endpoint, apiKey: quotaFake.key, options: { pollIntervalMs: 100 } })).body;
  const b1 = await c.post("/api/batches", { mode: "single", providerConfigId: p1.id, modelId: "muse-video", config: { durationSec: 5, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "Hết hạn mức" }] });
  await c.post(`/api/batches/${b1.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  env.startWorker();
  const failed = await waitFor(async () => (await c.get(`/api/jobs?batchId=${b1.body.batch.id}`)).body.jobs[0], (j: any) => j.status === "failed", 60_000);
  assert.equal(failed.error.code, "QUOTA");
  assert.equal(failed.attempt, 1, "hết hạn mức thì KHÔNG thử lại (tránh đốt thêm)");

  // 2. Sai key → AUTH, không thử lại
  const wrong = (await c.post("/api/providers", { providerType: "muse2api", endpoint: quotaFake.endpoint, apiKey: "m2a_sai_key", options: { pollIntervalMs: 100 } })).body;
  const b2 = await c.post("/api/batches", { mode: "single", providerConfigId: wrong.id, modelId: "muse-video", config: { durationSec: 5, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "Sai key" }] });
  await c.post(`/api/batches/${b2.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  const f2 = await waitFor(async () => (await c.get(`/api/jobs?batchId=${b2.body.batch.id}`)).body.jobs[0], (j: any) => j.status === "failed", 60_000);
  assert.equal(f2.error.code, "AUTH");
  assert.equal(f2.attempt, 1);

  // 3. 429 lúc gửi → thử lại rồi thành công
  const rl = await fakeMuse2Api(env, { rateLimitFirst: 1, processingPolls: 0 });
  const p3 = (await c.post("/api/providers", { providerType: "muse2api", endpoint: rl.endpoint, apiKey: rl.key, options: { pollIntervalMs: 100 } })).body;
  const b3 = await c.post("/api/batches", { mode: "single", providerConfigId: p3.id, modelId: "muse-video", config: { durationSec: 5, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "Bị 429 lần đầu" }] });
  await c.post(`/api/batches/${b3.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  const okJob = await waitFor(async () => (await c.get(`/api/jobs?batchId=${b3.body.batch.id}`)).body.jobs[0], (j: any) => j.status === "completed" || j.status === "failed", 90_000);
  assert.equal(okJob.status, "completed", "429 là lỗi tạm thời → phải thử lại và xong");

  // 4. Kiểm kết nối: dùng /v1/models + /readyz, KHÔNG tạo video
  const postsBefore = rl.requests.filter((r) => r.method === "POST" && r.url === "/v1/videos").length;
  const t = await c.post(`/api/providers/${p3.id}/test`);
  assert.equal(t.body.ok, true);
  assert.match(t.body.message, /tài khoản trong pool/);
  assert.equal(rl.requests.filter((r) => r.method === "POST" && r.url === "/v1/videos").length, postsBefore, "test không tạo video");
  assert.ok(rl.requests.some((r) => r.url === "/v1/models"));
  assert.ok(rl.requests.some((r) => r.url === "/readyz"));

  // 5. Pool chưa có tài khoản → test báo chưa sẵn sàng
  const empty = await fakeMuse2Api(env, { accounts: 0 });
  const p5 = (await c.post("/api/providers", { providerType: "muse2api", endpoint: empty.endpoint, apiKey: empty.key })).body;
  const t5 = await c.post(`/api/providers/${p5.id}/test`);
  assert.equal(t5.body.ok, false);
  assert.match(t5.body.message, /CHƯA có tài khoản Muse/);
});

test("muse2api: key không lộ ra API/DB/audit; service tắt thì báo PROVIDER_UNAVAILABLE", async () => {
  const env = await createEnv("m2a-secret");
  envs.push(env);
  const c = await userClient(env, "sec");
  const KEY = "m2a_SECRET_abcdef123456";
  const fake = await fakeMuse2Api(env, { key: KEY });
  const secret = KEY;
  const prov = (await c.post("/api/providers", { providerType: "muse2api", endpoint: fake.endpoint, apiKey: secret })).body;
  assert.equal(prov.hasApiKey, true);

  // Service đã tắt → lỗi phải nói rõ và chứng minh CHƯA gửi (provenNotSubmitted)
  const dead = (await c.post("/api/providers", { providerType: "muse2api", name: "Đã tắt", endpoint: "http://127.0.0.1:1", apiKey: secret, options: { pollIntervalMs: 100 } })).body;
  const b = await c.post("/api/batches", { mode: "single", providerConfigId: dead.id, modelId: "muse-video", config: { durationSec: 5, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "Service tắt" }] });
  await c.post(`/api/batches/${b.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  env.startWorker();
  const j = await waitFor(async () => (await c.get(`/api/jobs?batchId=${b.body.batch.id}`)).body.jobs[0], (x: any) => x.status === "failed", 90_000);
  assert.equal(j.error.code, "PROVIDER_UNAVAILABLE", "không nối được = chứng minh CHƯA gửi → được tạo lại an toàn");
  // Sau khi cạn số lần thử, BVS thay message bằng văn bản chuẩn của ERROR_MESSAGES;
  // chi tiết gốc ("Không gọi được muse2api...") được giữ ở cột error_detail để chẩn đoán
  assert.match(j.error.detail ?? "", /muse2api/, "error.detail phải ghi rõ không gọi được muse2api");
  assert.match(j.error.detail ?? "", /bad port|service muse2api/i, "nêu được nguyên nhân gốc");

  // Ngược lại: HẾT THỜI GIAN CHỜ thì không được kết luận là chưa gửi (request có thể đã tới Muse
  // và đang tiêu hạn mức) → BVS phải báo SUBMISSION_UNKNOWN thay vì tự gửi lại
  const hang = http.createServer(() => {
    /* không bao giờ trả lời */
  });
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
  servers.push(hang);
  const hangProv = (await c.post("/api/providers", {
    providerType: "muse2api",
    name: "Treo",
    endpoint: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`,
    apiKey: secret,
    options: { pollIntervalMs: 100, requestTimeoutMs: 1000 },
  })).body;
  const hb = await c.post("/api/batches", { mode: "single", providerConfigId: hangProv.id, modelId: "muse-video", config: { durationSec: 5, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "Server treo" }] });
  await c.post(`/api/batches/${hb.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  const hj = await waitFor(async () => (await c.get(`/api/jobs?batchId=${hb.body.batch.id}`)).body.jobs[0], (x: any) => x.status === "failed", 120_000);
  assert.equal(hj.error.code, "SUBMISSION_UNKNOWN", "quá thời gian chờ → KHÔNG tự gửi lại, tránh tạo trùng/tiêu hạn mức 2 lần");

  const everything = [
    JSON.stringify((await c.get("/api/providers")).body),
    JSON.stringify((await c.get("/api/audit")).body),
    JSON.stringify((await c.get(`/api/jobs?batchId=${b.body.batch.id}`)).body),
    JSON.stringify(env.ctx.db.all("SELECT * FROM video_provider_configurations")),
    JSON.stringify(env.ctx.db.all("SELECT * FROM audit_log")),
    JSON.stringify(env.ctx.db.all("SELECT * FROM job_events")),
  ].join("\n");
  assert.ok(!everything.includes(KEY), "không được lộ MUSE2API_KEY");
});

test("muse2api: mapMuseTask phân loại trạng thái và lỗi đúng", () => {
  assert.deepEqual(mapMuseTask({ status: "queued", progress: 10 }), { status: "queued", progress: 10 });
  assert.deepEqual(mapMuseTask({ status: "processing", progress: 55 }), { status: "processing", progress: 55 });
  assert.deepEqual(mapMuseTask({ status: "completed", progress: 100 }), { status: "completed", progress: 100 });
  // app.py chuẩn hoá succeeded/success/done
  assert.equal(mapMuseTask({ status: "succeeded" }).status, "completed");
  assert.equal(mapMuseTask({ status: "done" }).status, "completed");
  assert.equal(mapMuseTask({ status: "cancelled" }).status, "cancelled");
  // Trạng thái lạ → coi là đang chạy, không tự kết luận hỏng
  assert.equal(mapMuseTask({ status: "weird_new_state" }).status, "processing");

  assert.equal(mapMuseTask({ status: "failed", error: "cookie đã hết hạn, hãy đăng nhập lại" }).error!.category, "AUTH");
  assert.equal(mapMuseTask({ status: "failed", error: "额度 đã dùng hết" }).error!.category, "QUOTA");
  assert.equal(mapMuseTask({ status: "failed", error: "trợ lý từ chối nội dung này" }).error!.category, "CONTENT_POLICY");
  const t = mapMuseTask({ status: "failed", error: "等待生成超时 timeout" });
  assert.equal(t.error!.category, "TIMEOUT");
  assert.equal(t.error!.transient, true, "quá thời gian là lỗi tạm thời → được thử lại");
  const g = mapMuseTask({ status: "failed", error: "已生成但未能取回文件" });
  assert.equal(g.error!.category, "GENERATION_FAILED");
  assert.equal(g.error!.transient, false);
  // progress ngoài khoảng bị kẹp lại; thiếu progress thì giữ null (không được hoá 0)
  assert.equal(mapMuseTask({ status: "processing", progress: 999 }).progress, 100);
  assert.equal(mapMuseTask({ status: "processing", progress: -5 }).progress, 0);
  assert.equal(mapMuseTask({ status: "processing", progress: null }).progress, null);
  assert.equal(mapMuseTask({ status: "processing" }).progress, null, "thiếu progress phải là null, không phải 0");
  assert.equal(mapMuseTask({ status: "queued", progress: 10 }).progress, 10);
});
