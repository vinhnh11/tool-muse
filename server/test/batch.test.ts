import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, userClient, mockProviderId, tuneMock, createAndApprove, waitBatchDone, waitFor, type TestEnv } from "./helpers.ts";

/**
 * Kiểm thử luồng batch với MOCK provider (không tốn tiền, ffmpeg dựng video thật).
 * Tình huống nghiệm thu: 1, 2, 3, 4, 9, 10, 11.
 */
const envs: TestEnv[] = [];
after(async () => {
  for (const e of envs) await e.close();
});

test("1. Nhập 50 dòng prompt → đúng 50 job, không thiếu/không trùng, chạy xong đủ 50 video", async () => {
  const env = await createEnv("batch50");
  envs.push(env);
  const c = await userClient(env, "alice");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 80, maxConcurrency: 8, rpm: 1000 });

  const lines = Array.from({ length: 50 }, (_, i) => `Prompt số ${i + 1}: sản phẩm ${i + 1} xoay chậm trên nền màu ${i + 1}`);
  const text = ["", ...lines.slice(0, 25), "   ", ...lines.slice(25), ""].join("\n");
  const parsed = await c.post("/api/prompts/parse", { text, fileName: "prompts.txt" });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.items.length, 50);
  assert.deepEqual(parsed.body.blankLines, [1, 27]);
  assert.equal(parsed.body.summary, "50 dòng hợp lệ → 50 video");

  const est = await c.post("/api/batches/estimate", {
    providerConfigId: prov,
    modelId: "mock-standard",
    config: { durationSec: 4, aspectRatio: "9:16", resolution: "480p" },
    prompts: parsed.body.items.map((i: any) => i.draft),
    lines: parsed.body.items.map((i: any) => i.line),
    blankLines: parsed.body.blankLines,
    maxConcurrency: 8,
  });
  assert.equal(est.status, 200);
  assert.equal(est.body.check.summary, "50 dòng → 50 video");
  assert.equal(est.body.check.jobCount, 50);
  assert.equal(est.body.estimate.total, 0);

  const w = env.startWorker();
  const batchId = await createAndApprove(c, prov, lines, { maxConcurrency: 8 });
  const jobs = (await c.get(`/api/jobs?batchId=${batchId}&limit=500`)).body;
  assert.equal(jobs.total, 50);
  const seqs = jobs.jobs.map((j: any) => j.seq).sort((a: number, b: number) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));
  assert.equal(new Set(jobs.jobs.map((j: any) => j.prompt)).size, 50);

  const b = await waitBatchDone(c, batchId, 120_000);
  assert.equal(b.status, "completed");
  assert.equal(b.counts.completed, 50);
  const done = (await c.get(`/api/jobs?batchId=${batchId}&limit=500`)).body.jobs;
  assert.equal(new Set(done.map((j: any) => j.outputAssetId)).size, 50, "50 asset riêng biệt");
  const remote = env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mock_remote_tasks WHERE status != 'flag' AND provider_config_id = ?", prov)!.n;
  assert.equal(Number(remote), 50, "provider nhận đúng 50 yêu cầu, không gửi trùng");
  assert.ok((w.scheduler.observedMaxActive.get(prov) ?? 0) <= 8);
});

test("2 + 3. Prompt lỗi bị chặn TRƯỚC khi gọi provider; model không hỗ trợ 30 giây bị chặn", async () => {
  const env = await createEnv("validate");
  envs.push(env);
  const c = await userClient(env, "bob");
  const prov = mockProviderId(env, c.workspaceId);

  const long = "x ".repeat(400); // 800 ký tự > 500 của mock-short
  const r = await c.post("/api/batches", {
    mode: "list",
    providerConfigId: prov,
    modelId: "mock-short",
    config: { durationSec: 8, aspectRatio: "9:16", resolution: "720p" },
    prompts: [{ prompt: "Cảnh hợp lệ một" }, { prompt: "" }, { prompt: long }, { prompt: "Cảnh hợp lệ một" }, { prompt: "Có negative", negative: "mờ" }],
  });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "BATCH_INVALID");
  const codes = r.body.error.details.items.flatMap((i: any) => i.issues.map((x: any) => x.code));
  for (const c2 of ["EMPTY_PROMPT", "PROMPT_TOO_LONG", "DUPLICATE", "NEGATIVE_UNSUPPORTED"]) assert.ok(codes.includes(c2), `thiếu mã ${c2}: ${codes}`);
  assert.equal(r.body.error.details.items[3].duplicateOf, 1);

  // 30 giây trên model chỉ cho 4-15 giây
  const r30 = await c.post("/api/batches/estimate", { providerConfigId: prov, modelId: "mock-short", config: { durationSec: 30, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "Một cảnh 30 giây" }], maxConcurrency: 1 });
  assert.equal(r30.status, 200);
  assert.equal(r30.body.check.ok, false);
  assert.equal(r30.body.check.items[0].issues[0].code, "DURATION_UNSUPPORTED");
  assert.match(r30.body.check.items[0].issues[0].message, /4-15 giây/);
  const create30 = await c.post("/api/batches", { mode: "single", providerConfigId: prov, modelId: "mock-short", config: { durationSec: 30 }, prompts: [{ prompt: "Một cảnh 30 giây" }] });
  assert.equal(create30.status, 422);
  // Sinh prompt AI cho 30 giây trên model không hỗ trợ → chặn ngay (trước cả khi cần LLM)
  const gen = await c.post("/api/prompt-sets/generate", { count: 5, durationSec: 30, aspectRatio: "9:16", providerConfigId: prov, modelId: "mock-short" });
  assert.equal(gen.status, 422);
  assert.equal(gen.body.error.code, "DURATION_UNSUPPORTED");
  // Model hỗ trợ 30 giây thì qua
  const ok30 = await c.post("/api/batches/estimate", { providerConfigId: prov, modelId: "mock-standard", config: { durationSec: 30, aspectRatio: "9:16", resolution: "720p" }, prompts: [{ prompt: "Một cảnh 30 giây" }], maxConcurrency: 1 });
  assert.equal(ok30.body.check.ok, true);

  const remote = env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mock_remote_tasks")!.n;
  assert.equal(Number(remote), 0, "không có yêu cầu nào tới provider");
  assert.equal(Number(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_batches")!.n), 0, "không tạo batch lỗi");
});

test("4. Batch giới hạn 2 luồng không bao giờ chạy quá 2 job đồng thời (kể cả khi chọn 16 mà provider chỉ cho 2)", async () => {
  const env = await createEnv("concurrency");
  envs.push(env);
  const c = await userClient(env, "carol");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 400, maxConcurrency: 6, rpm: 1000 });
  const w = env.startWorker();

  const b1 = await createAndApprove(c, prov, Array.from({ length: 8 }, (_, i) => `Batch giới hạn 2 - cảnh ${i}`), { maxConcurrency: 2 });
  await waitBatchDone(c, b1);
  // Đo phía "provider": khoảng [created, finish) của các task không chồng quá 2
  const intervals = env.ctx.db.all<{ created_ms: number; finish_ms: number }>("SELECT created_ms, finish_ms FROM mock_remote_tasks WHERE status != 'flag'");
  const maxOverlap = (iv: { created_ms: number; finish_ms: number }[]) => {
    const pts = iv.flatMap((x) => [
      [x.created_ms, 1],
      [x.finish_ms, -1],
    ]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
    let cur = 0;
    let m = 0;
    for (const [, d] of pts) {
      cur += d!;
      m = Math.max(m, cur);
    }
    return m;
  };
  assert.ok(maxOverlap(intervals) <= 2, `provider thấy ${maxOverlap(intervals)} task chồng nhau`);
  assert.ok((w.scheduler.observedMaxActive.get(prov) ?? 0) <= 2);

  // Chọn 16 luồng nhưng provider chỉ cho 2 → hệ thống chạy tối đa 2
  tuneMock(env, prov, { latencyMs: 300, maxConcurrency: 2, rpm: 1000 });
  env.ctx.db.run("DELETE FROM mock_remote_tasks");
  w.scheduler.observedMaxActive.clear();
  const est = await c.post("/api/batches/estimate", { providerConfigId: prov, modelId: "mock-standard", config: { durationSec: 4 }, prompts: [{ prompt: "a b c" }], maxConcurrency: 16 });
  assert.equal(est.body.estimate.effectiveConcurrency, 2);
  assert.ok(est.body.estimate.notes.some((n: string) => n.includes("16 luồng")));
  const b2 = await createAndApprove(c, prov, Array.from({ length: 6 }, (_, i) => `Batch chọn 16 - cảnh ${i}`), { maxConcurrency: 16 });
  await waitBatchDone(c, b2);
  assert.ok(maxOverlap(env.ctx.db.all("SELECT created_ms, finish_ms FROM mock_remote_tasks WHERE status != 'flag'")) <= 2);
  assert.ok((w.scheduler.observedMaxActive.get(prov) ?? 0) <= 2);
});

test("9 + 10. Hủy một job không hủy cả batch; video xong xem/tải được ngay khi job khác còn chạy", async () => {
  const env = await createEnv("cancel");
  envs.push(env);
  const c = await userClient(env, "dave");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 700, maxConcurrency: 1, rpm: 1000 });
  env.startWorker();
  const batchId = await createAndApprove(c, prov, ["Cảnh A đầu tiên", "Cảnh B thứ hai", "Cảnh C thứ ba", "Cảnh D thứ tư"], { maxConcurrency: 1 });
  const jobs = (await c.get(`/api/jobs?batchId=${batchId}`)).body.jobs.sort((a: any, b: any) => a.seq - b.seq);
  const third = jobs[2];
  const cancel = await c.post(`/api/jobs/${third.id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.cancelled, true);
  assert.equal(cancel.body.job.status, "cancelled");

  // Job đầu xong trong khi batch còn chạy → xem + tải + tua (Range) được ngay
  const first = await waitFor(async () => (await c.get(`/api/jobs/${jobs[0].id}`)).body, (j: any) => j.status === "completed", 30_000);
  const batchNow = (await c.get(`/api/batches/${batchId}`)).body;
  assert.equal(batchNow.status, "running", "batch vẫn đang chạy");
  const file = await c.get(first.output.download.replace("?download=1", ""));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "video/mp4");
  assert.ok(file.raw.length > 1000);
  const ranged = await c.req("GET", `/api/assets/${first.outputAssetId}/file`, undefined, { Range: "bytes=0-99" });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.raw.length, 100);
  const dl = await c.get(first.output.download);
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
  const thumb = await c.get(first.output.thumbnail);
  assert.equal(thumb.status, 200);

  const done = await waitBatchDone(c, batchId);
  assert.equal(done.status, "completed");
  assert.equal(done.counts.completed, 3);
  assert.equal(done.counts.cancelled, 1);
});

test("11. Tạo V2 (sửa prompt) vẫn giữ nguyên V1", async () => {
  const env = await createEnv("versions");
  envs.push(env);
  const c = await userClient(env, "erin");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 100, maxConcurrency: 2, rpm: 1000 });
  env.startWorker();
  const batchId = await createAndApprove(c, prov, ["Phiên bản gốc: chai nước trên bàn gỗ"]);
  await waitBatchDone(c, batchId);
  const v1 = (await c.get(`/api/jobs?batchId=${batchId}`)).body.jobs[0];
  assert.equal(v1.version, 1);

  const regen = await c.post(`/api/jobs/${v1.id}/regenerate`, { prompt: "Phiên bản 2: chai nước trên bàn đá, ánh sáng sớm" });
  assert.equal(regen.status, 200);
  assert.equal(regen.body.version, 2);
  assert.equal(regen.body.status, "awaiting_approval", "phiên bản mới mặc định chờ duyệt");
  const appr = await c.post("/api/jobs/approve", { jobIds: [regen.body.id], confirm: true });
  assert.equal(appr.body.approved, 1);
  const v2 = await waitFor(async () => (await c.get(`/api/jobs/${regen.body.id}`)).body, (j: any) => j.status === "completed");
  assert.notEqual(v2.outputAssetId, v1.outputAssetId);
  const versions = (await c.get(`/api/jobs/${v1.id}/versions`)).body.versions;
  assert.deepEqual(versions.map((v: any) => v.version), [1, 2]);
  assert.equal(versions[0].outputAssetId, v1.outputAssetId, "V1 vẫn trỏ đúng asset cũ");
  const f1 = await c.get(`/api/assets/${v1.outputAssetId}/file`);
  assert.equal(f1.status, 200, "file V1 vẫn còn");
  const gv = env.ctx.db.all<{ version: number }>("SELECT version FROM generation_versions WHERE lineage_id = ? ORDER BY version", v1.lineageId);
  assert.deepEqual(gv.map((x) => x.version), [1, 2]);
});

test("Hủy mọi job của batch CHỜ DUYỆT → batch thành 'cancelled'; duyệt batch không còn job chờ bị từ chối; batch kẹt tự phục hồi", async () => {
  const env = await createEnv("cancel-awaiting");
  envs.push(env);
  const c = await userClient(env, "gina");
  const prov = mockProviderId(env, c.workspaceId);
  const r = await c.post("/api/batches", { mode: "list", providerConfigId: prov, modelId: "mock-standard", config: { durationSec: 4 }, prompts: [{ prompt: "Chờ duyệt một" }, { prompt: "Chờ duyệt hai" }] });
  const id = r.body.batch.id;
  const cp = await c.post(`/api/batches/${id}/cancel-pending`);
  assert.equal(cp.body.cancelled, 2);
  const b = (await c.get(`/api/batches/${id}`)).body;
  assert.equal(b.status, "cancelled");
  const appr = await c.post(`/api/batches/${id}/approve`, { confirm: true });
  assert.equal(appr.status, 409);
  assert.equal((await c.get(`/api/batches/${id}`)).body.status, "cancelled");

  // Batch còn job nhưng một job bị hủy lẻ → vẫn chờ duyệt; duyệt khi 0 job chờ (ép trạng thái) → NOTHING_TO_APPROVE
  const r2 = await c.post("/api/batches", { mode: "list", providerConfigId: prov, modelId: "mock-standard", config: { durationSec: 4 }, prompts: [{ prompt: "Giữ" }, { prompt: "Hủy lẻ" }] });
  const jobs2 = (await c.get(`/api/jobs?batchId=${r2.body.batch.id}`)).body.jobs;
  await c.post(`/api/jobs/${jobs2.find((j: any) => j.prompt === "Hủy lẻ").id}/cancel`);
  assert.equal((await c.get(`/api/batches/${r2.body.batch.id}`)).body.status, "awaiting_approval");
  env.ctx.db.run("UPDATE video_batch_jobs SET status = 'cancelled' WHERE batch_id = ?", r2.body.batch.id);
  const a2 = await c.post(`/api/batches/${r2.body.batch.id}/approve`, { confirm: true });
  assert.equal(a2.status, 409);
  assert.equal(a2.body.error.code, "NOTHING_TO_APPROVE");

  // Batch "running" mà không còn job nào chưa xong (dữ liệu cũ bị kẹt) → worker tự chuyển trạng thái đúng
  env.ctx.db.run("UPDATE video_batches SET status = 'running' WHERE id = ?", id);
  env.startWorker();
  await waitFor(async () => (await c.get(`/api/batches/${id}`)).body.status, (s) => s === "cancelled", 5000);
});

test("Lịch sử sự kiện (REST) cùng định dạng với SSE: {id,type,batchId,jobId,from,to,message,data,at}", async () => {
  const env = await createEnv("events-shape");
  envs.push(env);
  const c = await userClient(env, "hank");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 80, maxConcurrency: 2, rpm: 1000 });
  env.startWorker();
  const b = await createAndApprove(c, prov, ["Sự kiện"]);
  await waitBatchDone(c, b);
  const job = (await c.get(`/api/jobs?batchId=${b}`)).body.jobs[0];
  for (const p of [`/api/jobs/${job.id}/events`, `/api/batches/${b}/events`]) {
    const ev = (await c.get(p)).body.events;
    assert.ok(ev.length > 0);
    for (const e of ev) {
      assert.deepEqual(Object.keys(e).sort(), ["at", "batchId", "data", "from", "id", "jobId", "message", "to", "type"]);
      assert.equal(e.batchId, b);
    }
    assert.ok(ev.some((e: any) => e.type === "job.status" && e.to === "completed"));
  }
});
