// Chế độ phát triển: chạy API server (node, đọc .ts trực tiếp) + Vite dev server (HMR) cùng lúc.
//   npm run dev            → API http://127.0.0.1:7878, giao diện http://127.0.0.1:5173 (proxy /api → API)
//   PORT=7900 npm run dev  → đổi cổng API (Vite tự proxy theo)
// Ctrl+C dừng cả hai. Chạy production: npm run build && npm start (một cổng duy nhất).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.PORT || "7878";
const apiUrl = `http://127.0.0.1:${apiPort}`;
const env = { ...process.env, PORT: apiPort, BVS_API_URL: apiUrl };

const procs = [];
function start(name, args) {
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}]`;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.write(`${tag} ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    console.log(`${tag} đã dừng (mã ${code})`);
    shutdown(code ?? 0);
  });
  procs.push(p);
  return p;
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("api", ["server/src/main.ts"]);
start("web", [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--config", "web/vite.config.ts"]);
console.log(`[dev] API: ${apiUrl}  |  Giao diện: http://127.0.0.1:5173`);
