import { createContext } from "./context.ts";
import { Worker } from "./worker.ts";

/** Worker riêng (WORKER_MODE=off trên server). Chạy nhiều bản song song an toàn nhờ lease trong DB. */
const ctx = createContext();
const worker = new Worker(ctx);
worker.start();
console.log(`[worker] ${worker.scheduler.workerId} đang chạy (DB: ${ctx.db.file})`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await worker.stop();
  ctx.db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
