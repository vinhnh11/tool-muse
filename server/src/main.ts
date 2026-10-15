import { createContext } from "./context.ts";
import { createApp } from "./http.ts";
import { Worker } from "./worker.ts";
import * as auth from "./auth.ts";

/** Server: web + API (+ worker inline nếu WORKER_MODE=inline) */
const ctx = createContext();
const app = createApp(ctx);
let worker: Worker | null = null;
const server = app.listen(ctx.cfg.port, ctx.cfg.host, (err?: Error) => {
  // Express 5 chuyển lỗi listen (vd. EADDRINUSE) vào callback - phải dừng hẳn, không để worker "mồ côi"
  if (err) {
    console.error(`[server] Không mở được cổng ${ctx.cfg.host}:${ctx.cfg.port}: ${err.message}`);
    ctx.db.close();
    process.exit(1);
  }
  console.log(`[server] Batch Video Studio: http://${ctx.cfg.host}:${ctx.cfg.port}`);
  if (auth.countUsers(ctx.db) === 0) console.log("[server] Chưa có tài khoản - mở trang web để tạo tài khoản quản trị đầu tiên.");
  // Worker chỉ khởi động SAU khi đã nghe cổng thành công
  if (ctx.cfg.workerMode === "inline") {
    worker = new Worker(ctx);
    worker.start();
    console.log(`[server] Worker inline: ${worker.scheduler.workerId}`);
  } else {
    console.log("[server] WORKER_MODE=off - chạy `npm run worker` ở tiến trình riêng.");
  }
});

let closing = false;
async function shutdown(sig: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[server] ${sig} - dừng nhận việc, chờ thao tác dở...`);
  server.close();
  await worker?.stop();
  ctx.db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
