import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createEnv, userClient, type TestEnv } from "./helpers.ts";

/**
 * Dọn negative prompt cả bộ: cần khi model đích KHÔNG nhận negative
 * (vd Muse qua muse2api). Prompt chính phải giữ nguyên, chỉ negative bị bỏ trống.
 */
const envs: TestEnv[] = [];
after(async () => {
  for (const e of envs) await e.close();
});

/** Tạo bộ prompt có negative sẵn (giả lập bộ sinh lúc model còn nhận negative) */
async function makeSetWithNegatives(c: Awaited<ReturnType<typeof userClient>>) {
  const r = await c.post("/api/prompt-sets", {
    name: "Bộ có negative",
    items: [
      { title: "Một", prompt: "Chai nước hoa xoay chậm trên nền đá cẩm thạch", negative: "no shaky camera, no blurry label" },
      { title: "Hai", prompt: "Cận cảnh giọt nước đọng trên vỏ chai lạnh", negative: "no people, no text overlay" },
      { title: "Ba", prompt: "Máy lia ngang qua dãy sản phẩm trên kệ gỗ", negative: "" },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { id: string; items: { id: string; prompt: string; negative: string | null }[] };
}

test("Dọn negative cả bộ: negative về null, prompt chính không đổi", async () => {
  const env = await createEnv("clear-neg");
  envs.push(env);
  const c = await userClient(env, "neguser");

  const set = await makeSetWithNegatives(c);
  const before = set.items.map((i) => i.prompt);
  assert.equal(set.items.filter((i) => (i.negative ?? "").trim()).length, 2, "phải có 2 dòng mang negative");

  const r = await c.post(`/api/prompt-sets/${set.id}/clear-negatives`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.cleared, 2, "chỉ dọn 2 dòng thật sự có negative");

  const after2 = (await c.get(`/api/prompt-sets/${set.id}`)).body;
  assert.equal(after2.items.length, 3, "không được mất prompt nào");
  for (const it of after2.items) assert.equal(it.negative, null, "mọi negative phải trống");
  assert.deepEqual(
    after2.items.map((i: { prompt: string }) => i.prompt),
    before,
    "prompt chính phải giữ nguyên từng ký tự",
  );
});

test("Dọn lần hai: không còn gì để dọn, trả về 0 (idempotent)", async () => {
  const env = await createEnv("clear-neg-twice");
  envs.push(env);
  const c = await userClient(env, "neguser2");

  const set = await makeSetWithNegatives(c);
  assert.equal((await c.post(`/api/prompt-sets/${set.id}/clear-negatives`, {})).body.cleared, 2);
  const second = await c.post(`/api/prompt-sets/${set.id}/clear-negatives`, {});
  assert.equal(second.status, 200);
  assert.equal(second.body.cleared, 0, "lần hai không dọn thêm dòng nào");
});

test("Bộ prompt không tồn tại: báo 404, không âm thầm bỏ qua", async () => {
  const env = await createEnv("clear-neg-404");
  envs.push(env);
  const c = await userClient(env, "neguser3");

  const r = await c.post("/api/prompt-sets/pset_khongtontai/clear-negatives", {});
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, "NOT_FOUND");
});

test("MCP tool video_clear_negatives: dọn được và báo đúng số dòng", async () => {
  const env = await createEnv("clear-neg-mcp");
  envs.push(env);
  const c = await userClient(env, "neguser4");

  const set = await makeSetWithNegatives(c);
  const r = await c.post("/api/tools/video_clear_negatives", { args: { promptSetId: set.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cleared, 2);
  assert.match(r.body.summary, /2 prompt/);

  const after2 = (await c.get(`/api/prompt-sets/${set.id}`)).body;
  for (const it of after2.items) assert.equal(it.negative, null);
});

test("Bộ không có negative nào: tool báo rõ là không cần dọn", async () => {
  const env = await createEnv("clear-neg-none");
  envs.push(env);
  const c = await userClient(env, "neguser5");

  const r0 = await c.post("/api/prompt-sets", {
    name: "Bộ sạch",
    items: [{ title: "Sạch", prompt: "Một cảnh bình minh trên biển, máy bay chậm" }],
  });
  const r = await c.post("/api/tools/video_clear_negatives", { args: { promptSetId: r0.body.id } });
  assert.equal(r.body.cleared, 0);
  assert.match(r.body.summary, /không có negative/i);
});
