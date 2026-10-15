import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createEnv, userClient, mockProviderId, tuneMock, createAndApprove, waitBatchDone, waitFor, Client, type TestEnv } from "./helpers.ts";
import { renderMockVideo } from "../src/media.ts";
import * as auth from "../src/auth.ts";

/**
 * 8: phân quyền theo workspace. 12: API key không lộ ra frontend/log/DB/audit.
 * + Adapter Seedance (BytePlus ModelArk) chạy với MÁY CHỦ GIẢ theo đúng khuôn tài liệu
 *   (POST/GET/DELETE /contents/generations/tasks) - KHÔNG gọi BytePlus thật.
 */
const envs: TestEnv[] = [];
const servers: http.Server[] = [];
after(async () => {
  for (const e of envs) await e.close().catch(() => {});
  for (const s of servers) await new Promise((r) => s.close(r));
});

test("8. Người dùng khác không xem/tải/hủy được job, batch, asset của workspace khác", async () => {
  const env = await createEnv("perm");
  envs.push(env);
  const alice = await userClient(env, "alice");
  const mallory = await userClient(env, "mallory");
  const prov = mockProviderId(env, alice.workspaceId);
  tuneMock(env, prov, { latencyMs: 80, maxConcurrency: 2, rpm: 1000 });
  env.startWorker();
  const batchId = await createAndApprove(alice, prov, ["Video riêng tư của Alice"]);
  await waitBatchDone(alice, batchId);
  const job = (await alice.get(`/api/jobs?batchId=${batchId}`)).body.jobs[0];
  const assetId = job.outputAssetId;

  for (const p of [`/api/batches/${batchId}`, `/api/jobs/${job.id}`, `/api/jobs/${job.id}/versions`, `/api/assets/${assetId}`, `/api/assets/${assetId}/file`, `/api/assets/${assetId}/file?download=1`, `/api/assets/${assetId}/preview`, `/api/assets/${assetId}/thumbnail`, `/api/batches/${batchId}/export?format=zip`, `/api/batches/${batchId}/export?format=csv`]) {
    const r = await mallory.get(p);
    assert.equal(r.status, 404, `${p} phải 404 với người khác (được ${r.status})`);
  }
  assert.equal((await mallory.post(`/api/jobs/${job.id}/cancel`)).status, 404);
  assert.equal((await mallory.post(`/api/jobs/${job.id}/regenerate`, { prompt: "chiếm quyền" })).status, 404);
  assert.equal((await mallory.post(`/api/batches/${batchId}/pause`)).status, 404);
  assert.equal((await mallory.post("/api/assets/zip", { assetIds: [assetId] })).status, 404);
  // Danh sách của Mallory không chứa dữ liệu Alice
  assert.equal((await mallory.get("/api/jobs")).body.total, 0);
  assert.equal((await mallory.get("/api/library")).body.items.length, 0);
  // Chỉ định thẳng workspace của Alice → 404
  const forced = await mallory.req("GET", `/api/jobs/${job.id}`, undefined, { "X-Workspace-Id": alice.workspaceId });
  assert.equal(forced.status, 404);
  // API token của Mallory cũng không vượt quyền
  const mUser = env.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'mallory'")!;
  const tok = auth.createApiToken(env.ctx.db, mUser.id, "t");
  const agent = new Client(env.base);
  agent.bearer = tok.token;
  assert.equal((await agent.post("/api/tools/video_get_result", { args: { jobId: job.id } })).status, 404);
  // Chưa đăng nhập → 401; ghi bằng cookie thiếu header CSRF → 403
  assert.equal((await new Client(env.base).get(`/api/jobs/${job.id}`)).status, 401);
  const noCsrf = await fetch(`${env.base}/api/batches/${batchId}/pause`, { method: "POST", headers: { Cookie: alice.cookie } });
  assert.equal(noCsrf.status, 403);
  // Chủ sở hữu vẫn tải được
  assert.equal((await alice.get(`/api/assets/${assetId}/file`)).status, 200);
});

/** Máy chủ giả ModelArk: ghi lại request để kiểm khuôn; phục vụ một MP4 thật làm video_url */
async function fakeModelArk(env: TestEnv, behavior: { failCreate?: number; contentPolicy?: boolean; echoKeyInError?: boolean } = {}) {
  const mp4 = path.join(env.dir, "fake-result.mp4");
  await renderMockVideo(env.ctx.media, mp4, { durationSec: 4, aspect: "9:16", label: "fake modelark", withAudio: true });
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const tasks = new Map<string, { polls: number; status: string }>();
  let creates = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url!.startsWith("/files/result.mp4")) {
        // URL tải KHÔNG được mang API key
        if (req.headers.authorization) { res.writeHead(400); res.end("key leaked to download"); return; }
        res.writeHead(200, { "Content-Type": "video/mp4" });
        fs.createReadStream(mp4).pipe(res);
        return;
      }
      if (req.headers.authorization !== "Bearer ark-SECRET-key-0123456789") {
        send(401, { error: { code: "AuthenticationError", message: behavior.echoKeyInError ? `bad key ${req.headers.authorization}` : "bad key" } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/v3/contents/generations/tasks") {
        creates++;
        if (behavior.failCreate && creates <= behavior.failCreate) {
          send(429, { error: { code: "RateLimitExceeded.EndpointRPMExceeded", message: "rpm" } });
          return;
        }
        if (behavior.contentPolicy) {
          send(400, { error: { code: "InputTextSensitiveContentDetected", message: "sensitive" } });
          return;
        }
        const id = `cgt-${creates}`;
        tasks.set(id, { polls: 0, status: "queued" });
        send(200, { id });
        return;
      }
      const m = req.url!.match(/^\/api\/v3\/contents\/generations\/tasks\/([^/?]+)$/);
      if (m && req.method === "GET") {
        const t = tasks.get(m[1]!);
        if (!t) return send(404, { error: { code: "NotFound", message: "no task" } });
        t.polls++;
        if (t.status === "cancelled") return send(200, { id: m[1], status: "cancelled" });
        if (t.polls < 2) return send(200, { id: m[1], status: "running" });
        const port = (server.address() as AddressInfo).port;
        return send(200, { id: m[1], status: "succeeded", content: { video_url: `http://127.0.0.1:${port}/files/result.mp4?X-Tos-Signature=abc` }, usage: { completion_tokens: 100000, total_tokens: 100000 }, duration: 4 });
      }
      if (m && req.method === "DELETE") {
        const t = tasks.get(m[1]!);
        if (t && t.status === "queued") t.status = "cancelled";
        return send(200, {});
      }
      if (req.method === "GET" && req.url!.startsWith("/api/v3/contents/generations/tasks?")) return send(200, { items: [], total: 0 });
      send(404, { error: { code: "NotFound", message: req.url } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v3`, requests, tasks };
}

test("12 + Seedance adapter: đúng khuôn tài liệu ModelArk; API key không lộ ra API/log/DB/audit", async () => {
  const env = await createEnv("seedance");
  envs.push(env);
  const c = await userClient(env, "kim");
  const fake = await fakeModelArk(env);
  const KEY = "ark-SECRET-key-0123456789";

  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const created = await c.post("/api/providers", {
      providerType: "seedance-byteplus",
      name: "Seedance thử",
      endpoint: fake.endpoint,
      apiKey: KEY,
      maxConcurrency: 2,
      options: { pricePerSecond: { "480p": 0.01, "720p": 0.02 }, pricePerMillionTokens: 1.5, pollIntervalMs: 100 },
    });
    assert.equal(created.status, 200);
    const prov = created.body;
    assert.equal(prov.hasApiKey, true);
    assert.ok(!JSON.stringify(created.body).includes(KEY), "phản hồi tạo provider không chứa key");
    const list = await c.get("/api/providers");
    assert.ok(!list.raw.toString("utf8").includes(KEY), "GET /api/providers không chứa key");
    const caps = prov.capabilities;
    const m25 = caps.models.find((m: any) => m.modelId === "dreamina-seedance-2-5-260628");
    assert.deepEqual(m25.durations, { min: 4, max: 30, auto: true });
    assert.equal(caps.idempotency, false);
    assert.equal(caps.cancel, "queued_only");

    // Seedance 2.0 không cho 30 giây
    const est20 = await c.post("/api/batches/estimate", { providerConfigId: prov.id, modelId: "dreamina-seedance-2-0-260128", config: { durationSec: 30, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "30s" }], maxConcurrency: 2 });
    assert.equal(est20.body.check.items[0].issues[0].code, "DURATION_UNSUPPORTED");

    // Ước tính theo đơn giá người dùng nhập: 2 prompt × 10s × 0.02 = 0.4
    const batch = await c.post("/api/batches", {
      mode: "list",
      providerConfigId: prov.id,
      modelId: "dreamina-seedance-2-5-260628",
      config: { durationSec: 10, aspectRatio: "9:16", resolution: "720p", audio: true },
      prompts: [{ prompt: "Chai nước hoa xoay trên nền đen, ánh sáng viền" }, { prompt: "Người mẫu cầm chai nước hoa ngoài trời giờ vàng" }],
      maxConcurrency: 2,
      budgetLimit: 1,
    });
    assert.equal(batch.status, 200);
    assert.equal(batch.body.estimate.total, 0.4);
    assert.equal(batch.body.batch.status, "awaiting_approval");
    assert.equal(fake.requests.filter((r) => r.method === "POST").length, 0, "tạo batch KHÔNG gọi provider");
    const bid = batch.body.batch.id;
    // Duyệt thiếu xác nhận chi phí → 409
    assert.equal((await c.post(`/api/batches/${bid}/approve`, { confirm: true })).body.error.code, "COST_CONFIRMATION_MISMATCH");
    assert.equal((await c.post(`/api/batches/${bid}/approve`, { confirm: true, approvedMaxCost: 0.1 })).body.error.code, "COST_CONFIRMATION_MISMATCH");
    const ok = await c.post(`/api/batches/${bid}/approve`, { confirm: true, approvedMaxCost: 0.4 });
    assert.equal(ok.status, 200);

    env.startWorker({ log: (l) => logs.push(l) });
    const done = await waitBatchDone(c, bid);
    assert.equal(done.counts.completed, 2);
    assert.equal(done.actualCost, 0.3, "chi phí thực tế = 2 × 100000 token × 1.5/1M");
    // Khuôn request đúng tài liệu
    const post = fake.requests.find((r) => r.method === "POST" && r.url === "/api/v3/contents/generations/tasks")!;
    assert.equal(post.headers.authorization, `Bearer ${KEY}`);
    assert.equal(post.body.model, "dreamina-seedance-2-5-260628");
    assert.equal(post.body.content[0].type, "text");
    assert.equal(post.body.ratio, "9:16");
    assert.equal(post.body.duration, 10);
    assert.equal(post.body.resolution, "720p");
    assert.equal(post.body.generate_audio, true);
    // Video đã chép về kho bền (không lưu URL tạm)
    const jobs = (await c.get(`/api/jobs?batchId=${bid}`)).body.jobs;
    for (const j of jobs) {
      const a = env.ctx.db.get<{ storage_path: string; sha256: string }>("SELECT storage_path, sha256 FROM video_assets WHERE id = ?", j.outputAssetId)!;
      assert.ok(fs.existsSync(env.ctx.storage.abs(a.storage_path)));
      assert.ok(!a.storage_path.includes("http"));
    }

    // Lỗi xác thực + key bị provider "vọng lại" trong lỗi → phải bị che trong mọi nơi
    const fakeEcho = await fakeModelArk(env, { echoKeyInError: true });
    const wrong = await c.post("/api/providers", { providerType: "seedance-byteplus", name: "Sai key", endpoint: fakeEcho.endpoint, apiKey: "ark-WRONG-key-987654321", options: { pollIntervalMs: 100 } });
    const tb = await c.post("/api/batches", { mode: "single", providerConfigId: wrong.body.id, modelId: "dreamina-seedance-2-5-260628", config: { durationSec: 5, resolution: "480p" }, prompts: [{ prompt: "key sai" }] });
    await c.post(`/api/batches/${tb.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
    const failed = await waitFor(async () => (await c.get(`/api/jobs?batchId=${tb.body.batch.id}`)).body.jobs[0], (j: any) => j.status === "failed");
    assert.equal(failed.error.code, "AUTH");
    assert.equal(failed.attempt, 1, "lỗi xác thực không thử lại");
    const test1 = await c.post(`/api/providers/${wrong.body.id}/test`);
    assert.equal(test1.body.ok, false);

    // Quét mọi nơi: phản hồi API, DB (dạng rõ), audit, log
    const everything = [
      JSON.stringify((await c.get(`/api/jobs?batchId=${tb.body.batch.id}`)).body),
      JSON.stringify((await c.get("/api/providers")).body),
      JSON.stringify((await c.get("/api/audit")).body),
      JSON.stringify(test1.body),
      JSON.stringify(env.ctx.db.all("SELECT * FROM video_batch_jobs")),
      JSON.stringify(env.ctx.db.all("SELECT * FROM audit_log")),
      JSON.stringify(env.ctx.db.all("SELECT * FROM job_events")),
      JSON.stringify(env.ctx.db.all("SELECT * FROM video_provider_configurations")),
      logs.join("\n"),
    ].join("\n");
    for (const k of [KEY, "ark-WRONG-key-987654321"]) assert.ok(!everything.includes(k), `lộ key ${k.slice(0, 8)}…`);
    assert.ok(!everything.includes("X-Tos-Signature=abc"), "chữ ký signed URL không được lưu/log");
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

test("Seedance: 429 khi gửi → thử lại có backoff; lỗi nội dung → không thử lại; hủy được job còn xếp hàng", async () => {
  const env = await createEnv("seedance2");
  envs.push(env);
  const c = await userClient(env, "lee");
  const KEY = "ark-SECRET-key-0123456789";
  const fake = await fakeModelArk(env, { failCreate: 1 });
  const p = (await c.post("/api/providers", { providerType: "seedance-byteplus", endpoint: fake.endpoint, apiKey: KEY, options: { pollIntervalMs: 100 } })).body;
  env.startWorker();
  const b = await c.post("/api/batches", { mode: "single", providerConfigId: p.id, modelId: "dreamina-seedance-2-5-260628", config: { durationSec: 5, resolution: "480p" }, prompts: [{ prompt: "lần đầu bị 429" }] });
  await c.post(`/api/batches/${b.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  const done = await waitBatchDone(c, b.body.batch.id);
  assert.equal(done.counts.completed, 1);
  const j = (await c.get(`/api/jobs?batchId=${b.body.batch.id}`)).body.jobs[0];
  assert.equal(j.attempt, 2);

  const fake2 = await fakeModelArk(env, { contentPolicy: true });
  const p2 = (await c.post("/api/providers", { providerType: "seedance-byteplus", endpoint: fake2.endpoint, apiKey: KEY, options: { pollIntervalMs: 100 } })).body;
  const b2 = await c.post("/api/batches", { mode: "single", providerConfigId: p2.id, modelId: "dreamina-seedance-2-5-260628", config: { durationSec: 5, resolution: "480p" }, prompts: [{ prompt: "nội dung bị chặn" }] });
  await c.post(`/api/batches/${b2.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  const f = await waitFor(async () => (await c.get(`/api/jobs?batchId=${b2.body.batch.id}`)).body.jobs[0], (x: any) => x.status === "failed");
  assert.equal(f.error.code, "CONTENT_POLICY");
  assert.equal(f.attempt, 1);
  assert.equal(fake2.requests.filter((r) => r.method === "POST").length, 1);

  // Hủy: dừng worker, đặt job đang 'processing' với task còn queued ở provider → DELETE → cancelled
  await env.stopWorker();
  const fake3 = await fakeModelArk(env);
  const p3 = (await c.post("/api/providers", { providerType: "seedance-byteplus", endpoint: fake3.endpoint, apiKey: KEY, options: { pollIntervalMs: 60_000 } })).body;
  const b3 = await c.post("/api/batches", { mode: "single", providerConfigId: p3.id, modelId: "dreamina-seedance-2-5-260628", config: { durationSec: 5, resolution: "480p" }, prompts: [{ prompt: "sẽ bị hủy" }, { prompt: "giữ lại" }] });
  await c.post(`/api/batches/${b3.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true });
  env.startWorker({ pollIntervalMs: 60_000 });
  const jobs3 = await waitFor(async () => (await c.get(`/api/jobs?batchId=${b3.body.batch.id}`)).body.jobs, (js: any[]) => js.every((x) => x.status === "processing"), 10_000);
  const target = jobs3.find((x: any) => x.prompt === "sẽ bị hủy");
  const cancel = await c.post(`/api/jobs/${target.id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.cancelled, true);
  assert.ok(fake3.requests.some((r) => r.method === "DELETE" && r.url.endsWith(target.remoteJobId)));
  const other = (await c.get(`/api/jobs/${jobs3.find((x: any) => x.prompt === "giữ lại").id}`)).body;
  assert.equal(other.status, "processing", "job còn lại không bị hủy theo");
});
