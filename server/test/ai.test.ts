import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createEnv, userClient, mockProviderId, tuneMock, waitFor, waitBatchDone, type TestEnv } from "./helpers.ts";
import { run } from "../src/media.ts";
import * as auth from "../src/auth.ts";
import { ROOT_DIR } from "../src/config.ts";

/**
 * Tính năng AI chạy với LLM GIẢ (máy chủ chuẩn OpenAI chat completions trên localhost):
 * - Phân tích video: ffmpeg trích khung THẬT phủ toàn video, gửi ảnh cho model, không gửi tên file,
 *   coverage trung thực (chưa cấu hình model nghe → không có nội dung âm thanh).
 * - Batch Prompt Generator: đúng số lượng, loại trùng, tôn trọng giới hạn model.
 * - Chat điều phối: gọi tool tạo batch CHỜ DUYỆT; không tự duyệt provider tính phí.
 * - MCP server: liệt kê + gọi tool qua REST bằng API token.
 */
const envs: TestEnv[] = [];
const servers: http.Server[] = [];
after(async () => {
  for (const e of envs) await e.close().catch(() => {});
  for (const s of servers) await new Promise((r) => s.close(r));
});

interface LlmLog {
  system: string;
  userText: string;
  images: number;
  audios: number;
  tools: boolean;
}

async function fakeLlm(script: { chat?: (body: any, n: number) => any } = {}) {
  const calls: LlmLog[] = [];
  let chatTurns = 0;
  let promptChunk = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const msgs = body.messages ?? [];
      const system = String(msgs.find((m: any) => m.role === "system")?.content ?? "");
      const user = msgs.filter((m: any) => m.role === "user").pop();
      const parts = Array.isArray(user?.content) ? user.content : [{ type: "text", text: String(user?.content ?? "") }];
      const log: LlmLog = {
        system,
        userText: parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"),
        images: parts.filter((p: any) => p.type === "image_url").length,
        audios: parts.filter((p: any) => p.type === "input_audio").length,
        tools: Array.isArray(body.tools) && body.tools.length > 0,
      };
      calls.push(log);
      const reply = (content: string, toolCalls?: any[]) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      };
      if (log.tools && script.chat) {
        chatTurns++;
        const r = script.chat(body, chatTurns);
        return reply(r.content ?? "", r.toolCalls);
      }
      if (system.includes("chuyên gia phân tích video quảng cáo"))
        return reply(JSON.stringify({ summary: `Đoạn có ${log.images} khung`, subjects: ["chai nước"], actions: ["xoay"], camera: ["dolly-in"], composition: "giữa khung", lighting_color: "tương phản cao", on_screen_text: [], transitions: ["cắt cứng"], moments: [{ t: 0, description: "mở đầu" }] }));
      if (system.includes("Bạn nghe một đoạn âm thanh")) return reply(JSON.stringify({ speech_present: false, language: "", transcript: [], voice_tone: "", music: "nhạc điện tử", sound_effects: ["whoosh"] }));
      if (system.includes("giám đốc sáng tạo phân tích video tham khảo"))
        return reply(
          JSON.stringify({
            content: { summary: "Video sản phẩm", subjects: ["chai nước"], storyline: [{ start: 0, end: 3, description: "hook" }] },
            hook: { first_seconds: "cận cảnh", technique: "chuyển động nhanh", why_it_works: "bất ngờ" },
            visual_style: { look: "studio", lighting: "rim light", color_palette: ["#000000"], texture: "bóng" },
            camera: { movements: ["dolly-in"], shot_sizes: ["cận"], angles: ["ngang"] },
            composition_transitions: { composition: "giữa", transitions: ["cắt"] },
            pacing_storytelling: { structure: "hook-demo-cta", rhythm: "nhanh" },
            // Model "bịa" âm thanh - server phải xóa khi chưa thật sự nghe
            audio: { dialogue_summary: "BỊA: người nói giới thiệu", music: "BỊA", sound_effects: ["BỊA"], voice: "BỊA" },
            reusable_traits: ["xoay sản phẩm"],
            generation_hints: { genre: "product", prompt_elements: ["rim light"], avoid: [] },
          }),
        );
      if (system.includes("ADN sáng tạo")) return reply(JSON.stringify({ core_ideas: ["sản phẩm xoay"], styles: ["studio tối"], hooks: ["cận cảnh bất ngờ"], structures: ["hook-demo-cta"], visual_motifs: ["ánh sáng viền"], audio_cues: [], must_keep: ["logo"] }));
      if (system.includes("viết prompt cho model TẠO VIDEO")) {
        promptChunk++;
        const u = JSON.parse(log.userText);
        const items = u.slots.map((s: any, i: number) => ({
          slot: s.slot,
          title: `Ý tưởng ${s.slot}`,
          objective: "Tăng nhận diện",
          // Lô đầu cố tình trả trùng ở phần tử thứ 2 → generator phải loại và viết lại
          prompt: ((x: any) => `Cảnh ${x.slot}: ${x.hook} trong ${x.setting}, cấu trúc ${x.structure}, thể loại ${x.genre}, máy quay biến thể ${x.slot * 7}`)(promptChunk === 1 && i === 1 ? u.slots[0] : s),
          negative: "mờ, vỡ hình",
          genre: s.genre,
        }));
        return reply(JSON.stringify({ items }));
      }
      if (system.includes("Viết lại một prompt")) return reply(JSON.stringify({ title: "Viết lại", objective: "mới", prompt: "Phiên bản viết lại: sản phẩm trên nền trắng, máy quay orbit chậm", negative: "" }));
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fake llm: không hiểu yêu cầu" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

async function makeVideo(env: TestEnv, seconds: number): Promise<string> {
  const f = path.join(env.dir, `ref-chai-nuoc-${seconds}.mp4`);
  await run(env.ctx.media.ffmpeg, [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=320x568:rate=24:duration=${seconds / 2}`,
    "-f", "lavfi", "-i", `smptebars=size=320x568:rate=24:duration=${seconds / 2}`,
    "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`,
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f,
  ]);
  return f;
}

async function upload(c: any, file: string, kind = "reference", sessionId?: string) {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(file)], { type: "video/mp4" }), path.basename(file));
  const res = await fetch(`${c.base}/api/assets?kind=${kind}${sessionId ? `&sessionId=${sessionId}` : ""}`, { method: "POST", headers: { Cookie: c.cookie, "X-BVS-Request": "1" }, body: fd });
  return { status: res.status, body: (await res.json()) as any };
}

test("Phân tích video: khung hình thật phủ toàn video, không gửi tên file, âm thanh không bịa khi chưa cấu hình model nghe", async () => {
  const env = await createEnv("analysis");
  envs.push(env);
  const c = await userClient(env, "nam");
  const llm = await fakeLlm();
  // Chưa cấu hình LLM → báo lỗi rõ, không xếp hàng
  const vid = await makeVideo(env, 50);
  const up = await upload(c, vid);
  assert.equal(up.status, 200);
  const asset = up.body.assets[0];
  assert.equal(asset.hasAudio, true);
  const noCfg = await c.post("/api/analyses", { assetIds: [asset.id] });
  assert.equal(noCfg.status, 409);
  assert.equal(noCfg.body.error.code, "LLM_NOT_CONFIGURED");

  await c.req("PUT", "/api/settings/llm", { baseUrl: llm.url, apiKey: "llm-key-abcdef", textModel: "fake-text", visionModel: "fake-vision", audioModel: "" });
  env.startWorker();
  const r = await c.post("/api/analyses", { assetIds: [asset.id] });
  assert.equal(r.status, 200);
  const done = await waitFor(async () => (await c.get(`/api/analyses/${r.body.analyses[0].id}`)).body, (a: any) => a.status === "completed" || a.status === "failed", 120_000, 300);
  assert.equal(done.status, "completed", done.error);
  const cov = done.coverage;
  assert.equal(cov.wholeVideoCovered, true);
  assert.equal(cov.segments, 3, "50s / 20s = 3 đoạn");
  assert.ok(cov.hookFrames >= 6, "dày khung ở 3 giây đầu");
  assert.ok(Math.max(...cov.frameTimes) > 40, "có khung ở cuối video");
  assert.ok(cov.framesAnalyzed >= 20);
  assert.equal(cov.audio, "not_configured");
  assert.ok(done.measurements.sceneCuts.some((t: number) => t > 20 && t < 30), `phát hiện mốc chuyển cảnh thật ở ~25s: ${done.measurements.sceneCuts}`);
  // Âm thanh bịa đã bị xóa
  assert.equal(done.result.audio.status, "not_configured");
  assert.equal(done.result.audio.music, "");
  assert.equal(done.result.audio.dialogue_summary, "");
  // Model nhìn thấy ẢNH thật; tên file không bao giờ gửi đi
  const vision = llm.calls.filter((x) => x.system.includes("chuyên gia phân tích video quảng cáo"));
  assert.equal(vision.length, 3);
  assert.equal(vision.reduce((s, x) => s + x.images, 0), cov.framesAnalyzed);
  assert.ok(llm.calls.every((x) => !x.userText.includes("ref-chai-nuoc") && !x.system.includes("ref-chai-nuoc")), "không gửi tên file");

  // Có model nghe → phân tích âm thanh thật (gửi input_audio)
  await c.req("PUT", "/api/settings/llm", { audioModel: "fake-audio" });
  const r2 = await c.post("/api/analyses", { assetIds: [asset.id], force: true });
  const d2 = await waitFor(async () => (await c.get(`/api/analyses/${r2.body.analyses[0].id}`)).body, (a: any) => a.status === "completed" || a.status === "failed", 120_000, 300);
  assert.equal(d2.coverage.audio, "analyzed");
  assert.ok(llm.calls.some((x) => x.audios === 1));
});

test("Batch Prompt Generator: đúng 12 prompt, loại trùng, theo giới hạn model; duyệt/sửa/nhân bản/xóa/viết lại/xuất", async () => {
  const env = await createEnv("promptgen");
  envs.push(env);
  const c = await userClient(env, "oanh");
  const prov = mockProviderId(env, c.workspaceId);
  const llm = await fakeLlm();
  await c.req("PUT", "/api/settings/llm", { baseUrl: llm.url, textModel: "fake-text", visionModel: "fake-vision" });
  const g = await c.post("/api/prompt-sets/generate", { count: 12, durationSec: 30, aspectRatio: "9:16", providerConfigId: prov, modelId: "mock-standard", genres: ["product", "cinematic"], brief: "Quảng cáo chai nước" });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.generated, 12);
  assert.equal(g.body.shortfall, 0);
  const items = g.body.set.items;
  assert.equal(items.length, 12);
  assert.equal(new Set(items.map((i: any) => i.prompt)).size, 12, "không có prompt trùng");
  assert.ok(items.every((i: any) => i.durationSec === 30 && i.aspectRatio === "9:16" && i.approval === "pending"));
  assert.ok(llm.calls.filter((x) => x.system.includes("viết prompt cho model TẠO VIDEO")).length >= 3, "có lượt viết lại phần bị trùng");

  // Thao tác duyệt
  const setId = g.body.set.id;
  const first = items[0];
  const edited = await c.req("PATCH", `/api/prompt-items/${first.id}`, { prompt: "Prompt đã sửa tay", approval: "approved" });
  assert.equal(edited.body.prompt, "Prompt đã sửa tay");
  const dup = await c.post(`/api/prompt-items/${first.id}/duplicate`);
  assert.equal(dup.body.index, 2);
  assert.equal((await c.req("DELETE", `/api/prompt-items/${dup.body.id}`)).status, 200);
  const rw = await c.post(`/api/prompt-items/${items[1].id}/rewrite`, { instruction: "nền trắng", providerConfigId: prov, modelId: "mock-standard" });
  assert.match(rw.body.prompt, /viết lại/);
  await c.post(`/api/prompt-sets/${setId}/approval`, { itemIds: "all", approval: "approved" });
  const txt = await c.get(`/api/prompt-sets/${setId}/export?format=txt`);
  assert.equal(txt.body.trim().split("\n").length, 12, "TXT: 12 dòng = 12 prompt");
  const csv = await c.get(`/api/prompt-sets/${setId}/export?format=csv`);
  assert.match(String(csv.body), /index,title,objective,prompt/);
  const js = await c.get(`/api/prompt-sets/${setId}/export?format=json`);
  assert.equal(JSON.parse(String(js.raw)).prompts.length, 12);

  // Model chỉ 4-15 giây → không sinh prompt 30 giây
  const bad = await c.post("/api/prompt-sets/generate", { count: 5, durationSec: 30, aspectRatio: "9:16", providerConfigId: prov, modelId: "mock-short" });
  assert.equal(bad.body.error.code, "DURATION_UNSUPPORTED");
});

test("Chat điều phối (Hermes trong ứng dụng): tạo batch CHỜ DUYỆT, không tự duyệt provider tính phí; mock thì chạy được", async () => {
  const env = await createEnv("chat");
  envs.push(env);
  const c = await userClient(env, "phuc");
  const mock = mockProviderId(env, c.workspaceId);
  tuneMock(env, mock, { latencyMs: 80, maxConcurrency: 2, rpm: 1000 });
  const paid = (await c.post("/api/providers", { providerType: "seedance-byteplus", endpoint: "http://127.0.0.1:9/api/v3", apiKey: "ark-key-xxxxxxx", options: { pricePerSecond: { "720p": 0.05 } } })).body;
  let paidBatchId = "";
  const llm = await fakeLlm({
    chat(body, n) {
      const msgs = body.messages;
      const lastTool = [...msgs].reverse().find((m: any) => m.role === "tool");
      if (n === 1) return { toolCalls: [{ id: "c1", type: "function", function: { name: "video_get_provider_capabilities", arguments: "{}" } }] };
      if (n === 2)
        return {
          toolCalls: [
            { id: "c2", type: "function", function: { name: "video_create_batch", arguments: JSON.stringify({ prompts: ["Cảnh một: chai nước trên đá", "Cảnh hai: chai nước dưới mưa"], providerConfigId: paid.id, modelId: "dreamina-seedance-2-5-260628", config: { durationSec: 10, resolution: "720p" } }) } },
          ],
        };
      if (n === 3) {
        paidBatchId = JSON.parse(lastTool.content).batchId;
        return { toolCalls: [{ id: "c3", type: "function", function: { name: "video_approve_batch", arguments: JSON.stringify({ batchId: paidBatchId, confirm: true, approvedMaxCost: 999 }) } }] };
      }
      if (n === 4) return { content: "Đã tạo batch, chi phí ước tính 1 USD - bạn bấm Duyệt & chạy để bắt đầu." };
      // Lượt 2: mock miễn phí → được duyệt từ chat
      if (n === 5) return { toolCalls: [{ id: "c5", type: "function", function: { name: "video_create_batch", arguments: JSON.stringify({ prompts: ["Mock một", "Mock hai"], providerConfigId: mock, modelId: "mock-standard", config: { durationSec: 4, resolution: "480p" } }) } }] };
      if (n === 6) return { toolCalls: [{ id: "c6", type: "function", function: { name: "video_approve_batch", arguments: JSON.stringify({ batchId: JSON.parse(lastTool.content).batchId, confirm: true }) } }] };
      return { content: "Đã chạy batch mock." };
    },
  });
  await c.req("PUT", "/api/settings/llm", { baseUrl: llm.url, textModel: "fake-text", visionModel: "fake-vision" });
  const s = (await c.post("/api/sessions", { title: "Chat thử" })).body;
  const r1 = await c.post(`/api/sessions/${s.id}/chat`, { message: "Tạo 2 video Seedance 10 giây về chai nước", mode: "auto" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const toolMsgs = r1.body.messages.filter((m: any) => m.role === "tool");
  assert.equal(toolMsgs.length, 3);
  const created = JSON.parse(toolMsgs[1].content);
  assert.equal(created.status, "awaiting_approval");
  assert.equal(created.estimate.total, 1);
  const approveTry = JSON.parse(toolMsgs[2].content);
  assert.equal(approveTry.needsUserApproval, true, "chat KHÔNG được tự duyệt provider tính phí");
  const b = (await c.get(`/api/batches/${paidBatchId}`)).body;
  assert.equal(b.status, "awaiting_approval");
  assert.equal(b.sessionId, s.id, "batch gắn với phiên chat");
  // Lịch sử còn sau khi tải lại
  const hist = await c.get(`/api/sessions/${s.id}/chat`);
  assert.ok(hist.body.messages.length >= 5);

  env.startWorker();
  const r2 = await c.post(`/api/sessions/${s.id}/chat`, { message: "Chạy thử 2 video mock", mode: "auto" });
  const t2 = r2.body.messages.filter((m: any) => m.role === "tool");
  const mockBatch = JSON.parse(t2[0].content).batchId;
  assert.equal(JSON.parse(t2[1].content).status, "running");
  const done = await waitBatchDone(c, mockBatch);
  assert.equal(done.counts.completed, 2);
  // Hệ thống prompt nêu rõ luật chi phí
  assert.ok(llm.calls.some((x) => x.tools && x.system.includes("Không bao giờ tự chạy việc tốn phí")));
});

test("MCP server (cho Hermes Agent): liệt kê tool + gọi tool bằng API token qua REST", async () => {
  const env = await createEnv("mcp");
  envs.push(env);
  const c = await userClient(env, "quan");
  const u = env.ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'quan'")!;
  const tok = auth.createApiToken(env.ctx.db, u.id, "hermes");
  const child = spawn(process.execPath, [path.join(ROOT_DIR, "server", "src", "mcp.ts")], { env: { ...process.env, BVS_URL: env.base, BVS_TOKEN: tok.token }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (v: any) => void>();
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout ${method}`)), 15_000);
    });
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc("tools/list", {});
    const names = list.result.tools.map((t: any) => t.name);
    for (const n of ["video_analyze", "video_generate_prompts", "video_get_provider_capabilities", "video_estimate_batch", "video_create_batch", "video_get_batch_status", "video_pause_batch", "video_resume_batch", "video_cancel_job", "video_retry_job", "video_get_result", "video_regenerate", "video_export_batch"])
      assert.ok(names.includes(n), `thiếu tool ${n}`);
    const caps = await rpc("tools/call", { name: "video_get_provider_capabilities", arguments: {} });
    const capsJson = JSON.parse(caps.result.content[0].text);
    assert.equal(capsJson.providers[0].type, "mock");
    const created = await rpc("tools/call", { name: "video_create_batch", arguments: { prompts: ["MCP một", "MCP hai"], config: { durationSec: 4, resolution: "480p" } } });
    const cj = JSON.parse(created.result.content[0].text);
    assert.equal(cj.status, "awaiting_approval");
    const noConfirm = await rpc("tools/call", { name: "video_approve_batch", arguments: { batchId: cj.batchId, confirm: false } });
    assert.equal(noConfirm.result.isError, true);
    assert.match(noConfirm.result.content[0].text, /CONFIRMATION_REQUIRED/);
    const ok = await rpc("tools/call", { name: "video_approve_batch", arguments: { batchId: cj.batchId, confirm: true } });
    assert.equal(JSON.parse(ok.result.content[0].text).status, "running");
    const audit = env.ctx.db.all<{ actor: string; action: string }>("SELECT actor, action FROM audit_log WHERE action = 'batch.approve'");
    assert.equal(audit[0]!.actor, "api-token");
    void c;
  } finally {
    child.kill();
  }
});
