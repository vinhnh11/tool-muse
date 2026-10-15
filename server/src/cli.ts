import fs from "node:fs";
import path from "node:path";
import { createContext } from "./context.ts";
import * as auth from "./auth.ts";
import { ROOT_DIR } from "./config.ts";

/**
 * CLI cho người quản trị + agent ngoài (Hermes...).
 *   node server/src/cli.ts user create <username> <password>
 *   node server/src/cli.ts token create <username> [tên]
 *   node server/src/cli.ts tools                       (liệt kê tool - cần server chạy)
 *   node server/src/cli.ts call <tool> '<json args>'   (gọi tool qua API - cần BVS_TOKEN)
 * Biến môi trường: BVS_URL (mặc định http://127.0.0.1:7878), BVS_TOKEN, BVS_WORKSPACE (tùy chọn)
 */
const [cmd, sub, ...rest] = process.argv.slice(2);
const BASE = (process.env.BVS_URL || `http://127.0.0.1:${process.env.PORT || 7878}`).replace(/\/+$/, "");

async function api(method: string, p: string, body?: unknown): Promise<unknown> {
  const token = process.env.BVS_TOKEN;
  if (!token) throw new Error("Thiếu BVS_TOKEN (tạo bằng: node server/src/cli.ts token create <username>).");
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(process.env.BVS_WORKSPACE ? { "X-Workspace-Id": process.env.BVS_WORKSPACE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${res.status} ${json?.error?.code ?? ""}: ${json?.error?.message ?? text}`);
  return json;
}

async function main(): Promise<void> {
  if (cmd === "user" && sub === "create") {
    const [username, password] = rest;
    if (!username || !password) throw new Error("Cú pháp: user create <username> <password>");
    const ctx = createContext();
    const isFirst = auth.countUsers(ctx.db) === 0;
    const { user, workspaceId } = auth.createUser(ctx.db, username, password, isFirst ? "admin" : "member");
    ctx.providers.ensureMock(workspaceId);
    console.log(JSON.stringify({ user, workspaceId }, null, 2));
    return;
  }
  if (cmd === "token" && sub === "create") {
    const [username, name] = rest;
    const ctx = createContext();
    const u = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = ?", String(username ?? "").toLowerCase());
    if (!u) throw new Error(`Không có người dùng "${username}".`);
    const t = auth.createApiToken(ctx.db, u.id, name || "cli");
    console.log(t.token);
    console.error("(Token chỉ hiện một lần - lưu vào biến BVS_TOKEN hoặc cấu hình MCP.)");
    return;
  }
  if (cmd === "tools") {
    const r = (await api("GET", "/api/tools")) as { tools: { name: string; alias: string; description: string }[] };
    for (const t of r.tools) console.log(`${t.name.padEnd(34)} ${t.alias.padEnd(34)} ${t.description.slice(0, 90)}`);
    return;
  }
  if (cmd === "call") {
    const tool = sub;
    if (!tool) throw new Error("Cú pháp: call <tool> '<json>'");
    let args: unknown = {};
    const raw = rest.join(" ").trim();
    if (raw.startsWith("@")) args = JSON.parse(fs.readFileSync(path.resolve(raw.slice(1)), "utf8"));
    else if (raw) args = JSON.parse(raw);
    const r = await api("POST", `/api/tools/${tool}`, { args });
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(fs.readFileSync(path.join(ROOT_DIR, "server", "src", "cli.ts"), "utf8").split("\n").slice(5, 13).join("\n"));
}

main().catch((e) => {
  console.error(`Lỗi: ${(e as Error).message}`);
  process.exit(1);
});
