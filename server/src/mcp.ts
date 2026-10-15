import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, toJsonSchema } from "./tools.ts";
import { ROOT_DIR } from "./config.ts";

/**
 * MCP server (stdio) cho Hermes Agent / Claude Code / agent khác: mỗi tool video_*
 * gọi REST API của server đang chạy bằng API token (BVS_TOKEN). Không đụng DB trực
 * tiếp → worker/quyền/ngân sách/audit đi đúng một đường như giao diện.
 *
 * Cấu hình: BVS_URL (mặc định http://127.0.0.1:7878), BVS_TOKEN, BVS_WORKSPACE (tùy chọn),
 * BVS_EXPORT_DIR (nơi lưu file xuất - mặc định data/exports).
 */
const BASE = (process.env.BVS_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const TOKEN = process.env.BVS_TOKEN || "";
const EXPORT_DIR = process.env.BVS_EXPORT_DIR || path.join(ROOT_DIR, "data", "exports");

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(process.env.BVS_WORKSPACE ? { "X-Workspace-Id": process.env.BVS_WORKSPACE } : {}) };
}

async function callTool(name: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/api/tools/${encodeURIComponent(name)}`, { method: "POST", headers: headers(), body: JSON.stringify({ args }) });
  const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `HTTP ${res.status}`), { code: json?.error?.code, details: json?.error?.details });
  // Xuất file: tải về đĩa để agent có đường dẫn thật
  const out = json as { downloadUrl?: string } | null;
  if (name === "video_export_batch" && out?.downloadUrl) {
    const r = await fetch(`${BASE}${out.downloadUrl}`, { headers: headers() });
    if (!r.ok) throw new Error(`Tải file xuất thất bại: HTTP ${r.status}`);
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const cd = r.headers.get("content-disposition") ?? "";
    const fname = decodeURIComponent(cd.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? cd.match(/filename="([^"]+)"/)?.[1] ?? `export-${Date.now()}`);
    const file = path.join(EXPORT_DIR, fname);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return { file, bytes: fs.statSync(file).size };
  }
  return json;
}

const server = new Server({ name: "batch-video-studio", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: `[${t.alias}] ${t.description}`, inputSchema: toJsonSchema(t.schema) as { type: "object"; properties?: Record<string, unknown> } })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!TOKEN) return { isError: true, content: [{ type: "text", text: "Thiếu BVS_TOKEN cho MCP server." }] };
  try {
    const r = await callTool(req.params.name, req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  } catch (e) {
    const err = e as Error & { code?: string; details?: unknown };
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: err.code ?? "ERROR", message: err.message, details: err.details ?? null } }, null, 2) }] };
  }
});

await server.connect(new StdioServerTransport());
