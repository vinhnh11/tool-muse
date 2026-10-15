import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createEnv, userClient, mockProviderId, tuneMock, createAndApprove, waitBatchDone, waitFor, Client, type TestEnv } from "./helpers.ts";
import * as auth from "../src/auth.ts";

/** Tình huống nghiệm thu 5 (retry), 6 (restart không mất hàng đợi), 7 (poll/webhook không tạo trùng asset) */
const envs: TestEnv[] = [];
after(async () => {
  for (const e of envs) await e.close().catch(() => {});
});

test("5. Lỗi tạm thời được thử lại có backoff; lỗi vĩnh viễn không thử lại; không thử lại vô hạn", async () => {
  const env = await createEnv("retry");
  envs.push(env);
  const c = await userClient(env, "fay");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 100, maxConcurrency: 4, rpm: 1000 });
  env.startWorker();
  const batchId = await createAndApprove(c, prov, [
    "Gửi lần đầu bị 503 [mock:transient-submit]",
    "Tạo lần đầu lỗi tạm thời [mock:transient-gen]",
    "Bị từ chối nội dung [mock:fail]",
    "Bình thường",
  ]);
  const b = await waitBatchDone(c, batchId);
  assert.equal(b.status, "completed");
  const jobs = (await c.get(`/api/jobs?batchId=${batchId}`)).body.jobs.sort((x: any, y: any) => x.seq - y.seq);
  const [submitRetry, genRetry, policy, normal] = jobs;
  assert.equal(submitRetry.status, "completed");
  assert.equal(submitRetry.attempt, 2, "gửi lại 1 lần sau 503");
  assert.equal(genRetry.status, "completed");
  assert.equal(genRetry.attempt, 2, "tạo lại 1 lần sau lỗi tạm thời");
  assert.equal(policy.status, "failed");
  assert.equal(policy.attempt, 1, "lỗi chính sách nội dung không thử lại");
  assert.equal(policy.error.code, "CONTENT_POLICY");
  assert.equal(normal.attempt, 1);
  const ev = (await c.get(`/api/jobs/${submitRetry.id}/events`)).body.events;
  assert.ok(ev.some((e: any) => e.to_status === "queued" && /Thử lại sau/.test(e.message ?? "")), "có sự kiện xếp lại kèm backoff");

  // Provider lỗi tạm thời mãi → dừng ở max_attempts (3), không lặp vô hạn
  tuneMock(env, prov, { latencyMs: 50, maxConcurrency: 4, failRate: 1, rpm: 1000 });
  const b2 = await createAndApprove(c, prov, ["Luôn lỗi tạm thời"]);
  await waitBatchDone(c, b2);
  const j = (await c.get(`/api/jobs?batchId=${b2}`)).body.jobs[0];
  assert.equal(j.status, "failed");
  assert.equal(j.attempt, 3);
  assert.equal(j.maxAttempts, 3);

  // Tạo lại thủ công job lỗi (mock miễn phí: confirm là đủ) → thêm lượt thử mới
  tuneMock(env, prov, { latencyMs: 50, maxConcurrency: 4, failRate: 0, rpm: 1000 });
  const noConfirm = await c.post(`/api/batches/${b2}/retry-failed`, {});
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.body.error.code, "CONFIRMATION_REQUIRED");
  const retry = await c.post(`/api/batches/${b2}/retry-failed`, { confirm: true });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.retried.length, 1);
  const j2 = await waitFor(async () => (await c.get(`/api/jobs/${j.id}`)).body, (x: any) => x.status === "completed");
  assert.equal(j2.attempt, 4);
});

test("6. Restart server/worker giữa chừng không mất hàng đợi, không gửi trùng", async () => {
  const env = await createEnv("restart");
  envs.push(env);
  const c = await userClient(env, "gus");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 600, maxConcurrency: 2, rpm: 1000 });
  env.startWorker();
  const batchId = await createAndApprove(c, prov, Array.from({ length: 6 }, (_, i) => `Khôi phục sau restart ${i}`), { maxConcurrency: 2 });
  await waitFor(async () => (await c.get(`/api/batches/${batchId}`)).body, (b: any) => (b.counts.processing ?? 0) >= 1, 15_000, 50);
  // "Sập" tiến trình: dừng worker + đóng DB + đóng server
  const dir = env.dir;
  await env.close();
  envs.splice(envs.indexOf(env), 1);

  const env2 = await createEnv("restart", { dir });
  envs.push(env2);
  const c2 = new Client(env2.base);
  assert.equal((await c2.post("/api/auth/login", { username: "gus", password: "matkhau-kiemthu-123" })).status, 200);
  const before = (await c2.get(`/api/batches/${batchId}`)).body;
  assert.equal(before.total, 6, "hàng đợi còn nguyên trong DB sau restart");
  env2.startWorker();
  const done = await waitBatchDone(c2, batchId, 60_000);
  assert.equal(done.counts.completed, 6);
  const remote = Number(env2.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mock_remote_tasks WHERE status != 'flag'")!.n);
  assert.equal(remote, 6, "mỗi job chỉ một task ở provider");
  const assets = Number(env2.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_assets WHERE source_job_id IS NOT NULL")!.n);
  assert.equal(assets, 6);
});

test("6b. Worker chết giữa lúc gửi: provider có idempotency → gửi lại ĐÚNG key cũ; mất phản hồi sau khi gửi không tạo trùng", async () => {
  const env = await createEnv("idem");
  envs.push(env);
  const c = await userClient(env, "hana");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 100, maxConcurrency: 2, rpm: 1000 });
  env.startWorker();
  // Provider đã tạo task nhưng client mất phản hồi
  const b = await createAndApprove(c, prov, ["Mất phản hồi khi gửi [mock:submit-timeout]"]);
  await waitBatchDone(c, b);
  const j = (await c.get(`/api/jobs?batchId=${b}`)).body.jobs[0];
  assert.equal(j.status, "completed");
  const tasks = env.ctx.db.all<{ idempotency_key: string }>("SELECT idempotency_key FROM mock_remote_tasks WHERE status != 'flag'");
  assert.equal(tasks.length, 1, "gửi lại cùng idempotency key không tạo task thứ hai");
  assert.equal(tasks[0]!.idempotency_key, `${j.id}#1`);

  // Lease hết hạn khi đang 'submitting' (worker chết) → xếp lại với resubmit_same_key
  await env.stopWorker();
  const b2 = await createAndApprove(c, prov, ["Worker chết giữa lúc gửi"]);
  const job = (await c.get(`/api/jobs?batchId=${b2}`)).body.jobs[0];
  env.ctx.db.run("UPDATE video_batch_jobs SET status = 'submitting', attempt = 1, idempotency_key = ?, lease_owner = 'dead-worker', lease_until = ? WHERE id = ?", `${job.id}#1`, Date.now() - 1, job.id);
  env.startWorker();
  const fin = await waitFor(async () => (await c.get(`/api/jobs/${job.id}`)).body, (x: any) => x.status === "completed");
  assert.equal(fin.attempt, 1, "không tăng attempt khi gửi lại cùng key");
  const ev = (await c.get(`/api/jobs/${job.id}/events`)).body.events;
  assert.ok(ev.some((e: any) => /đúng idempotency key cũ/.test(e.message ?? "")));
});

test("7. Poll trùng / webhook không tạo trùng asset; webhook sai token bị từ chối", async () => {
  const env = await createEnv("dedupe", { publicBaseUrl: "http://127.0.0.1:1" });
  envs.push(env);
  const c = await userClient(env, "ivan");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 100, maxConcurrency: 2, rpm: 1000 });
  env.startWorker();
  const b = await createAndApprove(c, prov, ["Kiểm chống trùng asset"]);
  await waitBatchDone(c, b);
  const j = (await c.get(`/api/jobs?batchId=${b}`)).body.jobs[0];

  // Ép job về 'processing' như thể có một lần poll/webhook nữa tới → finalize chạy lại
  await env.stopWorker();
  env.ctx.db.run("UPDATE video_batch_jobs SET status = 'processing', next_poll_at = 0, lease_owner = NULL, lease_until = NULL WHERE id = ?", j.id);
  const w = env.startWorker();
  await waitFor(async () => (await c.get(`/api/jobs/${j.id}`)).body, (x: any) => x.status === "completed");
  const assets = env.ctx.db.all("SELECT id FROM video_assets WHERE source_job_id = ?", j.id);
  assert.equal(assets.length, 1, "vẫn đúng 1 asset");
  assert.equal((await c.get(`/api/jobs/${j.id}`)).body.outputAssetId, j.outputAssetId);
  // Hai worker cùng poll một job: lease đảm bảo chỉ một bên nhận
  env.ctx.db.run("UPDATE video_batch_jobs SET status = 'processing', next_poll_at = 0, lease_owner = NULL, lease_until = NULL WHERE id = ?", j.id);
  await env.stopWorker();
  const { Scheduler } = await import("../src/scheduler.ts");
  const s1 = new Scheduler(env.ctx, { log: () => {} });
  const s2 = new Scheduler(env.ctx, { log: () => {} });
  const claimed1 = s1.claimForPoll();
  const claimed2 = s2.claimForPoll();
  assert.equal(claimed1.length + claimed2.length, 1, "chỉ một worker nhận được job");
  void w;

  // Webhook: token sai → 404, token đúng → chỉ đánh thức poll
  env.ctx.providers.update(c.workspaceId, prov, { enableWebhook: true });
  const row = env.ctx.providers.rowById(prov)!;
  const secret = env.ctx.secrets.decrypt(row.webhook_secret_enc!);
  const anon = new Client(env.base);
  const bad = await anon.req("POST", `/api/webhooks/provider/${prov}/sai-token`, { id: j.remoteJobId, status: "succeeded" });
  assert.equal(bad.status, 404);
  const good = await anon.req("POST", `/api/webhooks/provider/${prov}/${secret}`, { id: j.remoteJobId, status: "succeeded" });
  assert.equal(good.status, 200);
  assert.equal(good.body.matched, true);
  const after1 = env.ctx.db.all("SELECT id FROM video_assets WHERE source_job_id = ?", j.id);
  assert.equal(after1.length, 1);
  void auth;
  void path;
});
