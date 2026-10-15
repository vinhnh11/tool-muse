import type { AppContext } from "./context.ts";
import { AnalysisService } from "./analysis.ts";
import { Scheduler, type SchedulerOptions } from "./scheduler.ts";

/** Worker = Batch Scheduler + hàng đợi phân tích video. Chạy trong server (inline) hoặc tiến trình riêng. */
export class Worker {
  readonly scheduler: Scheduler;
  private analysis: AnalysisService;
  private ctx: AppContext;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = new Set<Promise<void>>();

  constructor(ctx: AppContext, opts: SchedulerOptions = {}) {
    this.ctx = ctx;
    this.scheduler = new Scheduler(ctx, opts);
    this.analysis = new AnalysisService(ctx);
  }

  start(): void {
    this.stopped = false;
    this.scheduler.start();
    const loop = () => {
      if (this.stopped) return;
      try {
        for (;;) {
          const r = this.analysis.claim(this.scheduler.workerId);
          if (!r) break;
          const p = this.analysis.run(r);
          this.running.add(p);
          p.finally(() => this.running.delete(p));
        }
      } catch (e) {
        console.error("[worker] analysis loop:", (e as Error).message);
      }
      this.timer = setTimeout(loop, 2000);
    };
    this.timer = setTimeout(loop, 50);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.scheduler.stop();
    await Promise.allSettled([...this.running]);
    void this.ctx;
  }
}
