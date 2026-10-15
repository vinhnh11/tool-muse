import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parsePrompts, detectFormat, checkList, toCsv, toTxt, parseCsv } from "../src/prompts.ts";
import { SecretBox, hashPassword, verifyPassword } from "../src/secrets.ts";
import { redact, similarity } from "../src/util.ts";
import { loadConfig } from "../src/config.ts";
import { createEnv, userClient, mockProviderId, tuneMock, createAndApprove, waitBatchDone, tmpDir, type TestEnv } from "./helpers.ts";

const envs: TestEnv[] = [];
after(async () => {
  for (const e of envs) await e.close().catch(() => {});
});

test("TXT: mỗi dòng một prompt; BOM, CRLF, dòng trống giữa, xuống dòng cuối", () => {
  const r = parsePrompts("\uFEFFmột\r\n\r\nhai\r\n  ba  \r\n\r\n", "txt");
  assert.deepEqual(r.items.map((i) => [i.line, i.draft.prompt]), [
    [1, "một"],
    [3, "hai"],
    [4, "ba"],
  ]);
  assert.deepEqual(r.blankLines, [2], "dòng trống cuối file không tính là lỗi");
  assert.equal(detectFormat("a.csv", "x"), "csv");
  assert.equal(detectFormat(undefined, '[{"prompt":"x"}]'), "json");
  assert.equal(detectFormat(undefined, "chữ thường"), "txt");
});

test("CSV: ngoặc kép, dấu phẩy và xuống dòng trong ô; cột prompt/negative/duration", () => {
  const csv = 'title,prompt,negative,duration\r\n"Cảnh 1","Chai nước, ánh sáng ""viền""",mờ,10\r\n,,,\r\nCảnh 2,"Dòng một\nDòng hai",,\r\n,,,\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows[1]![1], 'Chai nước, ánh sáng "viền"');
  const r = parsePrompts(csv, "csv");
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0]!.draft.title, "Cảnh 1");
  assert.equal(r.items[0]!.draft.negative, "mờ");
  assert.equal(r.items[0]!.draft.durationSec, 10);
  assert.match(r.items[1]!.draft.prompt, /Dòng một\s+Dòng hai|Dòng một\nDòng hai/);
  assert.deepEqual(r.blankLines, [3], "bản ghi trống giữa file được báo; bản ghi trống cuối file bỏ qua");
});

test("JSON: mảng chuỗi / {prompts:[...]} / lỗi cú pháp báo rõ", () => {
  assert.equal(parsePrompts('["a", "", "b"]', "json").items.length, 2);
  const o = parsePrompts('{"prompts":[{"prompt":"x","ratio":"9:16","duration":5}]}', "json");
  assert.equal(o.items[0]!.draft.aspectRatio, "9:16");
  assert.equal(o.items[0]!.draft.durationSec, 5);
  const bad = parsePrompts("[1,", "json");
  assert.equal(bad.items.length, 0);
  assert.match(bad.errors[0]!.message, /JSON không hợp lệ/);
});

test("checkList: trùng hệt (không phân biệt hoa thường/khoảng trắng) và gần trùng", () => {
  const r = parsePrompts(
    ["Chai nước trên bàn gỗ, ánh sáng sớm", "chai nước  trên bàn gỗ, ánh sáng sớm", "Chai nước trên bàn gỗ, ánh sáng sớm.", "Một ý tưởng hoàn toàn khác về giày chạy bộ"].join("\n"),
    "txt",
  );
  const c = checkList(r.items, r.blankLines);
  // Chuẩn hóa bỏ hoa/thường, khoảng trắng thừa, dấu câu → dòng 2 và 3 là trùng hệt dòng 1
  assert.deepEqual(c.duplicates, [
    { line: 2, duplicateOfLine: 1 },
    { line: 3, duplicateOfLine: 1 },
  ]);
  const base = "Chai nước khoáng đặt trên bàn gỗ sồi cạnh cửa sổ, ánh sáng sớm mai chiếu xiên, hơi nước đọng trên thân chai, máy quay dolly-in chậm rồi dừng ở logo";
  const near = parsePrompts([base, base + " thật rõ"].join("\n"), "txt");
  const nc = checkList(near.items, near.blankLines);
  assert.equal(nc.duplicates.length, 0);
  assert.equal(nc.nearDuplicates[0]?.line, 2, "gần trùng là cảnh báo, không phải lỗi");
  assert.ok(!c.uniqueLines.includes(2));
  assert.ok(similarity("abc def ghi", "xyz uvw rst") < 0.2);
});

test("Xuất TXT/CSV: TXT luôn đúng 1 dòng = 1 prompt; CSV thoát ký tự đúng và đọc lại được", () => {
  const prompts = ["Một", "Hai\ncó xuống dòng", 'Ba, "ngoặc"'];
  const txt = toTxt(prompts);
  assert.equal(txt.trim().split("\n").length, 3);
  const csv = toCsv(prompts.map((p, i) => ({ seq: i + 1, prompt: p })), ["seq", "prompt"]);
  const back = parseCsv(csv).filter((r) => r.some((x) => x !== ""));
  assert.deepEqual(back.slice(1).map((r) => r[1]), prompts);
});

test("SecretBox: mã hóa AES-GCM, phát hiện sửa dữ liệu, khóa chủ sai độ dài bị từ chối", () => {
  const dir = tmpDir("secrets");
  const cfg = loadConfig({ dataDir: dir, storageDir: path.join(dir, "s") });
  const box = new SecretBox(cfg);
  const blob = box.encrypt("ark-very-secret");
  assert.ok(!blob.includes("ark-very-secret"));
  assert.notEqual(box.encrypt("ark-very-secret"), blob, "IV ngẫu nhiên");
  assert.equal(box.decrypt(blob), "ark-very-secret");
  assert.equal(new SecretBox(cfg).decrypt(blob), "ark-very-secret", "khóa chủ tự sinh được lưu lại và dùng lại");
  const parts = blob.split(":");
  parts[3] = Buffer.from("tampered!!").toString("base64");
  assert.throws(() => box.decrypt(parts.join(":")));
  assert.throws(() => new SecretBox(loadConfig({ dataDir: dir, masterKey: Buffer.alloc(16).toString("base64") })), /32 byte/);
  const h = hashPassword("mat-khau-dai");
  assert.ok(verifyPassword("mat-khau-dai", h));
  assert.ok(!verifyPassword("sai", h));
  assert.equal(redact("lỗi Bearer abcdefghijklmnop key=ark-very-secret", ["ark-very-secret"]).includes("ark-very-secret"), false);
});

/** Đọc danh sách file trong ZIP từ central directory (không cần thư viện giải nén) */
function zipEntries(buf: Buffer): { name: string; size: number }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
  assert.ok(eocd >= 0, "ZIP hợp lệ (có EOCD)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28);
    const el = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    out.push({ name: buf.subarray(p + 46, p + 46 + nl).toString("utf8"), size });
    p += 46 + nl + el + cl;
  }
  return out;
}

test("Xuất batch: ZIP chứa đúng video đã xong + manifest + prompts; CSV/JSON/TXT; ZIP nhiều asset từ Thư viện", async () => {
  const env = await createEnv("export");
  envs.push(env);
  const c = await userClient(env, "rin");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 80, maxConcurrency: 3, rpm: 1000 });
  env.startWorker();
  const b = await createAndApprove(c, prov, ["Xuất một", "Xuất hai, có dấu phẩy", "Lỗi cố ý [mock:fail]"], { maxConcurrency: 3 });
  const done = await waitBatchDone(c, b);
  assert.equal(done.counts.completed, 2);
  assert.equal(done.counts.failed, 1);

  const zip = await c.get(`/api/batches/${b}/export?format=zip`);
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get("content-type") ?? "", /zip/);
  const entries = zipEntries(zip.raw);
  const names = entries.map((e) => e.name).sort();
  assert.equal(names.filter((n) => n.startsWith("videos/") && n.endsWith(".mp4")).length, 2, "chỉ video đã hoàn thành");
  for (const n of ["manifest.json", "prompts.csv", "prompts.txt"]) assert.ok(names.includes(n), `thiếu ${n}`);
  assert.ok(entries.filter((e) => e.name.endsWith(".mp4")).every((e) => e.size > 1000));

  const csv = await c.get(`/api/batches/${b}/export?format=csv`);
  assert.match(csv.headers.get("content-disposition") ?? "", /attachment/);
  const rows = parseCsv(String(csv.body).replace(/^\uFEFF/, "")).filter((r) => r.length > 1);
  assert.equal(rows.length, 4, "header + 3 job");
  const header = rows[0]!;
  assert.equal(rows[2]![header.indexOf("prompt")], "Xuất hai, có dấu phẩy");
  assert.equal(rows[3]![header.indexOf("error_code")], "CONTENT_POLICY");
  const json = JSON.parse((await c.get(`/api/batches/${b}/export?format=json`)).raw.toString("utf8"));
  assert.equal(json.jobs.length, 3);
  const txt = String((await c.get(`/api/batches/${b}/export?format=txt`)).body);
  assert.equal(txt.trim().split("\n").length, 3);

  const jobs = (await c.get(`/api/jobs?batchId=${b}`)).body.jobs.filter((j: any) => j.outputAssetId);
  const lib = await c.req("POST", "/api/assets/zip", { assetIds: [...jobs.map((j: any) => j.outputAssetId), jobs[0].outputAssetId] });
  assert.equal(lib.status, 200);
  assert.equal(zipEntries(lib.raw).length, 2, "trùng id chỉ đóng gói một lần");
  const added = await c.post("/api/assets/library", { assetIds: [jobs[0].outputAssetId] });
  assert.equal(added.body.updated, 1);
  const only = (await c.get("/api/library?libraryOnly=1")).body.items;
  assert.equal(only.length, 1);
  assert.equal(only[0].batchId, b);
});

test("SSE /api/events: nhận sự kiện trạng thái job theo thời gian thực và nối lại bằng Last-Event-ID không mất sự kiện", async () => {
  const env = await createEnv("sse");
  envs.push(env);
  const c = await userClient(env, "son");
  const prov = mockProviderId(env, c.workspaceId);
  tuneMock(env, prov, { latencyMs: 100, maxConcurrency: 2, rpm: 1000 });

  const ac = new AbortController();
  const res = await fetch(`${env.base}/api/events`, { headers: { Cookie: c.cookie }, signal: ac.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  const events: { id: number; type: string; data: any }[] = [];
  const pump = (async () => {
    let buf = "";
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = block.match(/^id: (\d+)$/m)?.[1];
          const type = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (id && type && data) events.push({ id: Number(id), type, data: JSON.parse(data) });
        }
      }
    } catch {
      /* abort */
    }
  })();
  env.startWorker();
  const b = await createAndApprove(c, prov, ["SSE một", "SSE hai"]);
  await waitBatchDone(c, b);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !events.some((e) => e.type === "batch.status" && e.data.to === "completed")) await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  await pump;
  const completed = events.filter((e) => e.type === "job.status" && e.data.to === "completed" && e.data.batchId === b);
  assert.equal(completed.length, 2, `nhận 2 sự kiện hoàn thành, có: ${events.map((e) => e.type + ":" + e.data.to).join(",")}`);
  assert.ok(events.every((e, i) => i === 0 || e.id > events[i - 1]!.id), "id tăng dần");

  // Nối lại từ giữa: nhận lại đúng phần còn thiếu
  const mid = events[Math.floor(events.length / 2)]!.id;
  const ac2 = new AbortController();
  const res2 = await fetch(`${env.base}/api/events`, { headers: { Cookie: c.cookie, "Last-Event-ID": String(mid) }, signal: ac2.signal });
  const r2 = res2.body!.getReader();
  let text = "";
  const end = Date.now() + 3000;
  while (Date.now() < end && !text.includes(`id: ${events[events.length - 1]!.id}\n`)) {
    const { value } = await Promise.race([r2.read(), new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 1500))]);
    if (value) text += new TextDecoder().decode(value);
  }
  ac2.abort();
  const ids2 = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(ids2, events.filter((e) => e.id > mid).map((e) => e.id));
  // Người khác không nhận sự kiện của workspace này
  const other = await userClient(env, "spy");
  const ac3 = new AbortController();
  const res3 = await fetch(`${env.base}/api/events?after=0`, { headers: { Cookie: other.cookie }, signal: ac3.signal });
  const r3 = res3.body!.getReader();
  const { value } = await Promise.race([r3.read(), new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 1500))]);
  ac3.abort();
  assert.ok(!new TextDecoder().decode(value ?? new Uint8Array()).includes(b));
});
