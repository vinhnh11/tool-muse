import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEnv, userClient, mockProviderId, tuneMock, createAndApprove, waitBatchDone, type TestEnv } from "./helpers.ts";

/**
 * Xóa video / xóa batch: file trên đĩa phải mất thật, DB sạch, và không được
 * xóa khi job còn đang chạy ở provider.
 */
const envs: TestEnv[] = [];
after(async () => {
  for (const e of envs) await e.close();
});

test("Xóa video đã tạo: mất file trên đĩa + mất khỏi thư viện, job vẫn giữ prompt", async () => {
  const env = await createEnv("del-assets");
  envs.push(env);
  const c = await userClient(env, "deluser");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 60, maxConcurrency: 4, rpm: 1000 });
  env.startWorker();

  const batchId = await createAndApprove(c, prov, ["Video rác số một", "Video rác số hai", "Video giữ lại"], { maxConcurrency: 3 });
  await waitBatchDone(c, batchId, 120_000);

  const lib = (await c.get("/api/library")).body.items;
  assert.equal(lib.length, 3);
  const victims = lib.slice(0, 2).map((i: any) => i.id);
  const files = victims.map((id: string) => {
    const row = env.ctx.db.get<{ storage_path: string }>("SELECT storage_path FROM video_assets WHERE id = ?", id)!;
    const f = env.ctx.storage.abs(row.storage_path);
    assert.ok(fs.existsSync(f), "file phải tồn tại trước khi xóa");
    return f;
  });

  const r = await c.post("/api/assets/delete", { assetIds: victims });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deleted.sort(), [...victims].sort());
  assert.ok(r.body.freedBytes > 0, "phải báo số byte giải phóng");

  for (const f of files) {
    assert.equal(fs.existsSync(f), false, "file video phải bị xóa khỏi đĩa");
    assert.equal(fs.existsSync(path.dirname(f)), false, "cả thư mục asset (thumb/preview) phải bị xóa");
  }
  assert.equal(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_assets WHERE id IN (?, ?)", victims[0], victims[1])!.n, 0);

  const after2 = (await c.get("/api/library")).body.items;
  assert.equal(after2.length, 1, "thư viện chỉ còn 1 video");

  // Job vẫn còn (prompt + chi phí để đối soát), chỉ mất liên kết output
  const jobs = (await c.get(`/api/jobs?batchId=${batchId}&limit=50`)).body.jobs;
  assert.equal(jobs.length, 3);
  assert.equal(jobs.filter((j: any) => j.outputAssetId === null).length, 2);

  // Asset đã xóa thì mọi route đọc trả 404
  assert.equal((await c.get(`/api/assets/${victims[0]}`)).status, 404);
  assert.equal((await c.get(`/api/assets/${victims[0]}/file`)).status, 404);

  // Xóa một asset không tồn tại: báo skipped, không ném lỗi
  const again = await c.post("/api/assets/delete", { assetIds: victims });
  assert.equal(again.status, 200);
  assert.equal(again.body.deleted.length, 0);
  assert.equal(again.body.skipped.length, 2);

  // DELETE một asset lẻ
  const one = await c.req("DELETE", `/api/assets/${after2[0].id}`);
  assert.equal(one.status, 200);
  assert.equal((await c.get("/api/library")).body.items.length, 0);
});

test("Xóa batch: xóa job + sự kiện + video; keepAssets giữ video lại; batch đang chạy bị chặn", async () => {
  const env = await createEnv("del-batch");
  envs.push(env);
  const c = await userClient(env, "deluser2");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 60, maxConcurrency: 4, rpm: 1000 });
  env.startWorker();

  // batch A: xóa cả video
  const a = await createAndApprove(c, prov, ["Rác A1", "Rác A2"], { maxConcurrency: 2 });
  await waitBatchDone(c, a, 120_000);
  const aAssets = (await c.get(`/api/jobs?batchId=${a}&limit=50`)).body.jobs.map((j: any) => j.outputAssetId);
  const aFiles = aAssets.map((id: string) => env.ctx.storage.abs(env.ctx.db.get<{ storage_path: string }>("SELECT storage_path FROM video_assets WHERE id = ?", id)!.storage_path));

  const delA = await c.req("DELETE", `/api/batches/${a}`);
  assert.equal(delA.status, 200);
  assert.equal(delA.body.jobsDeleted, 2);
  assert.equal(delA.body.assetsDeleted, 2);
  for (const f of aFiles) assert.equal(fs.existsSync(f), false);
  assert.equal((await c.get(`/api/batches/${a}`)).status, 404);
  assert.equal(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_batch_jobs WHERE batch_id = ?", a)!.n, 0);
  assert.equal(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_events WHERE batch_id = ? AND type != 'batch.deleted'", a)!.n, 0);
  assert.ok(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'batch.delete'")!.n >= 1, "có ghi audit");

  // batch B: giữ video
  const b = await createAndApprove(c, prov, ["Giữ B1"], { maxConcurrency: 1 });
  await waitBatchDone(c, b, 120_000);
  const bAsset = (await c.get(`/api/jobs?batchId=${b}&limit=50`)).body.jobs[0].outputAssetId as string;
  const delB = await c.req("DELETE", `/api/batches/${b}?keepAssets=1`);
  assert.equal(delB.status, 200);
  assert.equal(delB.body.assetsDeleted, 0);
  assert.equal((await c.get(`/api/assets/${bAsset}`)).status, 200, "video vẫn xem được sau khi xóa batch");
  assert.equal((await c.get("/api/library")).body.items.length, 1);

  // batch C: đang chạy → chặn xóa
  await env.stopWorker();
  tuneMock(env, prov, { latencyMs: 60_000, maxConcurrency: 2, rpm: 1000 });
  const cId = await createAndApprove(c, prov, ["Đang chạy C1", "Đang chạy C2"], { maxConcurrency: 2 });
  env.startWorker();
  await new Promise<void>((r) => {
    const t = setInterval(async () => {
      const st = (await c.get(`/api/batches/${cId}`)).body;
      if ((st.counts.processing ?? 0) + (st.counts.submitting ?? 0) > 0) {
        clearInterval(t);
        r();
      }
    }, 100);
  });
  const delC = await c.req("DELETE", `/api/batches/${cId}`);
  assert.equal(delC.status, 409);
  assert.equal(delC.body.error.code, "BATCH_ACTIVE");
});

test("Tool MCP video_delete_videos / video_delete_batch: cần confirm, xóa thật", async () => {
  const env = await createEnv("del-tools");
  envs.push(env);
  const c = await userClient(env, "deluser3");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 60, maxConcurrency: 4, rpm: 1000 });
  env.startWorker();
  const batchId = await createAndApprove(c, prov, ["Rác tool 1", "Rác tool 2"], { maxConcurrency: 2 });
  await waitBatchDone(c, batchId, 120_000);

  const noConfirm = await c.post("/api/tools/video_delete_videos", { args: { batchId, confirm: false } });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.body.error.code, "CONFIRMATION_REQUIRED");
  assert.equal((await c.get("/api/library")).body.items.length, 2, "không xóa gì khi chưa confirm");

  const ok = await c.post("/api/tools/video_delete_videos", { args: { batchId, confirm: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.deleted, 2);
  assert.equal((await c.get("/api/library")).body.items.length, 0);

  const delBatch = await c.post("/api/tools/video_delete_batch", { args: { batchId, confirm: true } });
  assert.equal(delBatch.status, 200);
  assert.equal(delBatch.body.jobsDeleted, 2);
  assert.equal((await c.get(`/api/batches/${batchId}`)).status, 404);
});

test("Dọn thư mục asset mồ côi trên đĩa", async () => {
  const env = await createEnv("del-orphan");
  envs.push(env);
  const c = await userClient(env, "deluser4");
  const orphan = env.ctx.storage.abs(path.join(c.workspaceId, "batches", "bat_x", "ast_mocoi_123"));
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "video.mp4"), Buffer.alloc(2048));

  const r = await c.post("/api/assets/prune-orphans");
  assert.equal(r.status, 200);
  assert.equal(r.body.removedDirs, 1);
  assert.equal(r.body.freedBytes, 2048);
  assert.equal(fs.existsSync(orphan), false);
});
