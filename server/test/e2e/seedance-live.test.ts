import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, userClient, waitBatchDone, type TestEnv } from "../helpers.ts";

/**
 * KIỂM THỬ THẬT với BytePlus ModelArk - TỐN PHÍ (1 video 4 giây 480p).
 * Chỉ chạy khi có cả hai biến:
 *   SEEDANCE_API_KEY=<key ModelArk>  BVS_E2E_ALLOW_COST=1
 * Tùy chọn: SEEDANCE_ENDPOINT, SEEDANCE_MODEL (mặc định dreamina-seedance-2-0-260128).
 * Không có biến → test bị bỏ qua (npm test không bao giờ tốn tiền).
 */
const KEY = process.env.SEEDANCE_API_KEY ?? "";
const ALLOW = process.env.BVS_E2E_ALLOW_COST === "1";
const envs: TestEnv[] = [];
after(async () => {
  for (const e of envs) await e.close().catch(() => {});
});

test("Seedance THẬT: tạo 1 video 4 giây 480p, tải về kho, có thumbnail", { skip: !(KEY && ALLOW) && "cần SEEDANCE_API_KEY + BVS_E2E_ALLOW_COST=1 (tốn phí)", timeout: 15 * 60_000 }, async () => {
  // Cho phép gọi mạng thật trong test này
  const env = await createEnv("seedance-live", { allowNetwork: true });
  envs.push(env);
  const c = await userClient(env, "live");
  const model = process.env.SEEDANCE_MODEL || "dreamina-seedance-2-0-260128";
  const p = await c.post("/api/providers", {
    providerType: "seedance-byteplus",
    apiKey: KEY,
    ...(process.env.SEEDANCE_ENDPOINT ? { endpoint: process.env.SEEDANCE_ENDPOINT } : {}),
    modelIds: [model],
    defaultModelId: model,
    maxConcurrency: 1,
    options: { pollIntervalMs: 5000 },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const t = await c.post(`/api/providers/${p.body.id}/test`);
  assert.equal(t.body.ok, true, `kiểm tra kết nối: ${t.body.message}`);
  const b = await c.post("/api/batches", {
    mode: "single",
    providerConfigId: p.body.id,
    modelId: model,
    config: { durationSec: 4, aspectRatio: "9:16", resolution: "480p", audio: false },
    prompts: [{ prompt: "A glass bottle of water slowly rotating on a dark studio table, soft rim light, macro shot" }],
    maxConcurrency: 1,
  });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const a = await c.post(`/api/batches/${b.body.batch.id}/approve`, { confirm: true, acknowledgeUnknownCost: true, approvedMaxCost: b.body.estimate.total ?? undefined });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  env.startWorker({ pollIntervalMs: 5000 });
  const done = await waitBatchDone(c, b.body.batch.id, 14 * 60_000);
  const job = (await c.get(`/api/jobs?batchId=${b.body.batch.id}`)).body.jobs[0];
  assert.equal(job.status, "completed", JSON.stringify(job.error));
  assert.equal(done.counts.completed, 1);
  const f = await c.get(`/api/assets/${job.outputAssetId}/file`);
  assert.equal(f.status, 200);
  assert.ok(f.raw.length > 10_000);
  console.log(`Seedance thật OK: remote=${job.remoteJobId} chi phí thực tế=${job.actualCost ?? "không xác định"} kích thước=${f.raw.length}B`);
});
