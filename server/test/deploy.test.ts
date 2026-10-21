import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, userClient, mockProviderId, tuneMock, waitBatchDone, type TestEnv } from "./helpers.ts";
import { PromptService } from "../src/promptgen.ts";
import { invokeTool } from "../src/tools.ts";

/**
 * TRIỂN KHAI bộ prompt: phân tích → sinh prompt → "Triển khai" → mỗi prompt = đúng 1 video.
 * Kiểm: đếm N prompt → N job (kể cả khi cấu hình "số lần tạo mỗi prompt" > 1), chọn prompt
 * đã duyệt / chưa bị loại, dryRun không tạo gì, Mock chạy luôn, provider tính phí dừng ở
 * CHỜ DUYỆT (kênh chat) hoặc cần confirm + approvedMaxCost đúng (MCP/API), prompt trùng bị chặn.
 */
const envs: TestEnv[] = [];
after(async () => {
  for (const e of envs) await e.close();
});

const PROMPTS = [
  "Cảnh 1: chai nước thể thao xoay chậm trên nền đá, giọt nước lăn trên thân chai",
  "Cảnh 2: cô gái chạy bộ buổi sáng, dừng lại uống nước dưới tán cây",
  "Cảnh 3: cận cảnh nắp chai bật mở, hơi lạnh tỏa ra",
  "Cảnh 4: chai nước trên bàn làm việc cạnh laptop, máy quay trượt ngang",
  "Cảnh 5: hộp quà mở ra có chai nước bên trong, nền trắng tối giản",
  "Cảnh 6: người dùng cầm chai nói về khả năng giữ lạnh 24 giờ",
];

async function setup(name: string) {
  const env = await createEnv(name);
  envs.push(env);
  const c = await userClient(env, "deployer");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 80, maxConcurrency: 4, rpm: 1000 });
  const userId = env.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'deployer'")!.id;
  const ps = new PromptService(env.ctx);
  const makeSet = () =>
    ps.createSet(c.workspaceId, { userId, kind: "ui" }, {
      name: "Bộ prompt từ phân tích",
      source: "ai",
      params: { providerConfigId: prov, modelId: "mock-standard", durationSec: 4, aspectRatio: "9:16" },
      items: PROMPTS.map((p, i) => ({ title: `Ý tưởng ${i + 1}`, prompt: p, durationSec: 4, aspectRatio: "9:16" })),
    });
  const batchCount = () => Number(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_batches WHERE workspace_id = ?", c.workspaceId)!.n);
  return { env, c, prov, userId, ps, makeSet, batchCount };
}

test("Triển khai: dryRun không tạo gì; N prompt (bỏ prompt đã loại / chỉ prompt đã duyệt) → đúng N video, bỏ qua 'số lần tạo mỗi prompt'", async () => {
  const { env, c, ps, makeSet, batchCount } = await setup("deploy-count");
  const set = makeSet();
  ps.setApproval(c.workspaceId, set.id, [set.items[5]!.id], "rejected");

  // Chưa duyệt prompt nào → auto = mọi prompt chưa bị loại = 5
  const dry = await c.post(`/api/prompt-sets/${set.id}/deploy`, { dryRun: true, config: { variantsPerPrompt: 4 } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.promptCount, 5);
  assert.equal(dry.body.videoCount, 5, "variantsPerPrompt bị ép = 1");
  assert.equal(dry.body.check.summary, "5 dòng → 5 video");
  assert.equal(dry.body.estimate.total, 0);
  assert.equal(dry.body.free, true);
  assert.equal(dry.body.batch, null);
  assert.equal(batchCount(), 0, "dryRun không tạo batch");

  // Duyệt 3 prompt → auto = chỉ 3 prompt đã duyệt
  const approvedIds = [set.items[0]!.id, set.items[2]!.id, set.items[4]!.id];
  ps.setApproval(c.workspaceId, set.id, approvedIds, "approved");
  env.startWorker();
  const r = await c.post(`/api/prompt-sets/${set.id}/deploy`, { config: { variantsPerPrompt: 4, resolution: "480p" }, run: { confirm: true, approvedMaxCost: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.promptCount, 3);
  assert.equal(r.body.videoCount, 3);
  assert.equal(r.body.approved, true);
  assert.deepEqual(r.body.promptIndexes, [1, 3, 5]);
  const batchId = r.body.batch.id as string;
  assert.equal(r.body.batch.promptSetId, set.id);
  const jobs = (await c.get(`/api/jobs?batchId=${batchId}&limit=50`)).body.jobs as any[];
  assert.equal(jobs.length, 3);
  assert.deepEqual(new Set(jobs.map((j) => j.prompt)), new Set([PROMPTS[0], PROMPTS[2], PROMPTS[4]]));
  const b = await waitBatchDone(c, batchId, 60_000);
  assert.equal(b.status, "completed");
  assert.equal(b.counts.completed, 3);
  const done = (await c.get(`/api/jobs?batchId=${batchId}&limit=50`)).body.jobs as any[];
  assert.equal(new Set(done.map((j) => j.outputAssetId)).size, 3, "3 video riêng biệt");

  // selection=all → mọi prompt chưa bị loại (5), kể cả khi đã có prompt được duyệt
  const all = await c.post(`/api/prompt-sets/${set.id}/deploy`, { selection: "all", dryRun: true });
  assert.equal(all.body.videoCount, 5);
  // selection=approved khi bộ chưa duyệt gì → báo lỗi rõ, không tạo batch
  const fresh = makeSet();
  const before = batchCount();
  const none = await c.post(`/api/prompt-sets/${fresh.id}/deploy`, { selection: "approved" });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, "NO_PROMPTS");
  assert.equal(batchCount(), before);
});

test("Triển khai: prompt trùng / vượt giới hạn bị chặn trước khi tạo batch (không thiếu, không trùng video)", async () => {
  const { c, ps, makeSet, batchCount } = await setup("deploy-invalid");
  const set = makeSet();
  ps.duplicateItem(c.workspaceId, set.items[1]!.id);
  const r = await c.post(`/api/prompt-sets/${set.id}/deploy`, { run: { confirm: true } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "BATCH_INVALID");
  assert.ok(r.body.error.details.items.some((i: any) => i.issues.some((x: any) => x.code === "DUPLICATE")));
  assert.equal(batchCount(), 0);
  // mock-short chỉ 4-15 giây → prompt 4 giây hợp lệ, nhưng ép 30 giây (bỏ thời lượng riêng) thì bị chặn
  const set2 = makeSet();
  const bad = await c.post(`/api/prompt-sets/${set2.id}/deploy`, { modelId: "mock-short", config: { durationSec: 30 }, useItemOverrides: false, dryRun: true });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.check.ok, false);
  assert.ok(bad.body.check.items.every((i: any) => i.issues.some((x: any) => x.code === "DURATION_UNSUPPORTED")));
});

test("Tool video_deploy_prompt_set: Mock chạy luôn; provider TÍNH PHÍ → chat dừng ở CHỜ DUYỆT, MCP cần confirm + approvedMaxCost đúng", async () => {
  const { env, c, userId, makeSet } = await setup("deploy-tool");
  const call = (channel: "chat" | "mcp", args: unknown) => invokeTool(env.ctx, { workspaceId: c.workspaceId, userId, channel }, "video_deploy_prompt_set", args) as Promise<any>;

  // Mock (miễn phí) qua chat → chạy luôn, 6 prompt → 6 video
  const s1 = makeSet();
  const free = await call("chat", { promptSetId: s1.id });
  assert.equal(free.approved, true);
  assert.equal(free.videoCount, 6);
  assert.equal(free.summary, "6 prompt → 6 video");
  assert.equal(free.status, "running");

  // Provider tính phí (Seedance, endpoint giả không bao giờ được gọi vì không chạy worker)
  const paid = (await c.post("/api/providers", { providerType: "seedance-byteplus", endpoint: "http://127.0.0.1:9/api/v3", apiKey: "ark-test-key-deploy-0001", options: { pricePerSecond: { "720p": 0.05 } } })).body;
  const s2 = makeSet();
  const target = { providerConfigId: paid.id, modelId: "dreamina-seedance-2-5-260628", config: { durationSec: 10, resolution: "720p" }, selection: "all" };
  const dry = await call("mcp", { promptSetId: s2.id, ...target, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.videoCount, 6);
  assert.equal(dry.free, false);
  // Mỗi prompt giữ thời lượng riêng 4s → 6 × 4s × 0.05 = 1.2
  assert.equal(dry.estimate.total, 1.2);

  const viaChat = await call("chat", { promptSetId: s2.id, ...target, confirm: true, approvedMaxCost: 999 });
  assert.equal(viaChat.approved, false, "kênh chat không được tự duyệt việc tính phí, kể cả khi model truyền confirm");
  assert.equal(viaChat.status, "awaiting_approval");
  assert.equal(viaChat.needsUserApproval, true);
  assert.equal((await c.get(`/api/batches/${viaChat.batchId}`)).body.status, "awaiting_approval");

  const noConfirm = await call("mcp", { promptSetId: s2.id, ...target });
  assert.equal(noConfirm.approved, false);
  assert.equal(noConfirm.status, "awaiting_approval");

  const tooLow = await call("mcp", { promptSetId: s2.id, ...target, confirm: true, approvedMaxCost: 0.5 });
  assert.equal(tooLow.approved, false);
  assert.equal(tooLow.approveError.code, "COST_CONFIRMATION_MISMATCH");
  assert.equal((await c.get(`/api/batches/${tooLow.batchId}`)).body.status, "awaiting_approval");

  const ok = await call("mcp", { promptSetId: s2.id, ...target, confirm: true, approvedMaxCost: 1.2 });
  assert.equal(ok.approved, true);
  assert.equal(ok.videoCount, 6);
  const b = (await c.get(`/api/batches/${ok.batchId}`)).body;
  assert.equal(b.status, "running");
  assert.equal(b.total, 6);
});
