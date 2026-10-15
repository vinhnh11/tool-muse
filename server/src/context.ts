import path from "node:path";
import { loadConfig, type AppConfig } from "./config.ts";
import { Db } from "./db.ts";
import { SecretBox } from "./secrets.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { Storage } from "./storage.ts";
import { LlmService } from "./llm.ts";
import type { MediaTools } from "./media.ts";

/** Mọi service dùng chung - tạo MỘT lần cho server, worker, CLI, MCP, test */
export interface AppContext {
  cfg: AppConfig;
  db: Db;
  secrets: SecretBox;
  media: MediaTools;
  providers: ProviderRegistry;
  storage: Storage;
  llm: LlmService;
  fetchImpl: typeof fetch;
}

export function createContext(overrides: Partial<AppConfig> = {}, opts: { fetchImpl?: typeof fetch } = {}): AppContext {
  const cfg = loadConfig(overrides);
  const db = new Db(cfg.dataDir);
  const secrets = new SecretBox(cfg);
  const media: MediaTools = { ffmpeg: cfg.ffmpegPath, ffprobe: cfg.ffprobePath };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const providers = new ProviderRegistry(db, secrets, media, { publicBaseUrl: cfg.publicBaseUrl, fetchImpl });
  const storage = new Storage(db, cfg.storageDir, media);
  const llm = new LlmService(db, secrets, fetchImpl);
  return { cfg, db, secrets, media, providers, storage, llm, fetchImpl };
}

export function dataPath(ctx: AppContext, ...parts: string[]): string {
  return path.join(ctx.cfg.dataDir, ...parts);
}
