import type { AppContext } from "./context.ts";
import { Scheduler, type SchedulerOptions } from "./scheduler.ts";

/** Worker = Batch Scheduler. Chạy trong server (inline) hoặc tiến trình riêng. */
export class Worker {
  readonly scheduler: Scheduler;
  private ctx: AppContext;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = new Set<Promise<void>>();

  constructor(ctx: AppContext, opts: SchedulerOptions = {}) {
    this.ctx = ctx;
    this.scheduler = new Scheduler(ctx, opts);
  }

  start(): void {
    this.stopped = false;
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.scheduler.stop();
    await Promise.allSettled([...this.running]);
    void this.ctx;
  }
}
