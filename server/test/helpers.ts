import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createContext, type AppContext } from "../src/context.ts";
import { createApp } from "../src/http.ts";
import { Worker } from "../src/worker.ts";
import * as auth from "../src/auth.ts";
import { ROOT_DIR } from "../src/config.ts";
import type { SchedulerOptions } from "../src/scheduler.ts";

process.env.BVS_SKIP_DOTENV = "1";

export const TMP_ROOT = path.join(ROOT_DIR, ".test-tmp");

export function tmpDir(name: string): string {
  const d = path.join(TMP_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** fetch chỉ cho phép localhost - mọi request ra ngoài bị chặn (test không bao giờ gọi dịch vụ thật/tốn tiền) */
export const localOnlyFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error(`TEST BLOCKED external fetch: ${url.hostname}`);
  return fetch(input, init);
};

export interface TestEnv {
  ctx: AppContext;
  dir: string;
  base: string;
  server: http.Server;
  worker: Worker | null;
  startWorker(opts?: SchedulerOptions): Worker;
  stopWorker(): Promise<void>;
  close(): Promise<void>;
}

export const FAST_WORKER: SchedulerOptions = { tickMs: 40, pollIntervalMs: 100, backoffBaseMs: 100, backoffMaxMs: 1000, leaseMs: 3000, log: () => {} };

export async function createEnv(name: string, opts: { dir?: string; publicBaseUrl?: string; allowNetwork?: boolean } = {}): Promise<TestEnv> {
  const dir = opts.dir ?? tmpDir(name);
  const ctx = createContext({ dataDir: path.join(dir, "data"), storageDir: path.join(dir, "storage"), publicBaseUrl: opts.publicBaseUrl ?? "", tickMs: 40 }, { fetchImpl: opts.allowNetwork ? fetch : localOnlyFetch });
  const app = createApp(ctx);
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: TestEnv = {
    ctx,
    dir,
    base,
    server,
    worker: null,
    startWorker(o?: SchedulerOptions) {
      env.worker = new Worker(ctx, { ...FAST_WORKER, ...o });
      env.worker.start();
      return env.worker;
    },
    async stopWorker() {
      await env.worker?.stop();
      env.worker = null;
    },
    async close() {
      await env.stopWorker();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      ctx.db.close();
    },
  };
  return env;
}

/** Client HTTP đóng vai trình duyệt (cookie + header CSRF) hoặc agent (Bearer token) */
export class Client {
  base: string;
  cookie = "";
  bearer = "";
  workspaceId = "";
  constructor(base: string) {
    this.base = base;
  }
  async req<T = any>(method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers; raw: Buffer }> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    if (method !== "GET") headers["X-BVS-Request"] = "1";
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const raw = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? "";
    const parsed = ct.includes("application/json") && raw.length ? JSON.parse(raw.toString("utf8")) : (raw.toString("utf8") as unknown);
    return { status: res.status, body: parsed as T, headers: res.headers, raw };
  }
  get<T = any>(p: string) {
    return this.req<T>("GET", p);
  }
  post<T = any>(p: string, body: unknown = {}) {
    return this.req<T>("POST", p, body);
  }
}

export async function userClient(env: TestEnv, username: string): Promise<Client> {
  const pw = "matkhau-kiemthu-123";
  const { workspaceId } = auth.createUser(env.ctx.db, username, pw);
  env.ctx.providers.ensureMock(workspaceId);
  const c = new Client(env.base);
  const r = await c.post("/api/auth/login", { username, password: pw });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  c.workspaceId = workspaceId;
  return c;
}

export function mockProviderId(env: TestEnv, workspaceId: string): string {
  const r = env.ctx.db.get<{ id: string }>("SELECT id FROM video_provider_configurations WHERE workspace_id = ? AND provider_type = 'mock'", workspaceId);
  return r!.id;
}

/** Cấu hình mock nhanh cho kiểm thử */
export function tuneMock(env: TestEnv, providerId: string, o: { latencyMs?: number; maxConcurrency?: number; failRate?: number; rpm?: number }) {
  env.ctx.providers.update(env.ctx.db.get<{ workspace_id: string }>("SELECT workspace_id FROM video_provider_configurations WHERE id = ?", providerId)!.workspace_id, providerId, {
    options: { latencyMs: o.latencyMs ?? 150, pollIntervalMs: 100, failRate: o.failRate ?? 0 },
    ...(o.maxConcurrency ? { maxConcurrency: o.maxConcurrency } : {}),
    ...(o.rpm ? { requestsPerMinute: o.rpm } : {}),
  });
}

export async function waitFor<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, timeoutMs = 30_000, stepMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T = await fn();
  while (Date.now() < end) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout; last=${JSON.stringify(last)?.slice(0, 500)}`);
}

export async function createAndApprove(c: Client, providerConfigId: string, prompts: string[], opts: { modelId?: string; config?: Record<string, unknown>; maxConcurrency?: number; budgetLimit?: number | null } = {}) {
  const r = await c.post("/api/batches", {
    mode: "list",
    providerConfigId,
    modelId: opts.modelId ?? "mock-standard",
    config: { durationSec: 4, aspectRatio: "9:16", resolution: "480p", audio: false, ...(opts.config ?? {}) },
    prompts: prompts.map((p) => ({ prompt: p })),
    maxConcurrency: opts.maxConcurrency ?? 2,
    budgetLimit: opts.budgetLimit ?? null,
  });
  if (r.status !== 200) throw new Error(`create batch ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.batch.id as string;
  const a = await c.post(`/api/batches/${id}/approve`, { confirm: true });
  if (a.status !== 200) throw new Error(`approve ${a.status} ${JSON.stringify(a.body)}`);
  return id;
}

export async function waitBatchDone(c: Client, batchId: string, timeoutMs = 60_000) {
  return waitFor(
    async () => (await c.get(`/api/batches/${batchId}`)).body,
    (b: any) => b.status === "completed" || b.status === "cancelled",
    timeoutMs,
    150,
  );
}
