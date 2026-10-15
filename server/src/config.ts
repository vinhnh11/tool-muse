import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Thư mục gốc của dự án (D:\tool) */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Nạp .env (nếu có) - biến đã có trong process.env thắng, giống dotenv */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

if (process.env.BVS_SKIP_DOTENV !== "1") loadDotEnv(path.join(ROOT_DIR, ".env"));

function resolveDir(v: string | undefined, fallback: string): string {
  const p = v && v.trim() ? v.trim() : fallback;
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  storageDir: string;
  masterKey: string;
  workerMode: "inline" | "off";
  ffmpegPath: string;
  ffprobePath: string;
  editInboxDir: string;
  publicBaseUrl: string;
  /** Chu kỳ scheduler (ms) */
  tickMs: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const cfg: AppConfig = {
    port: Number(process.env.PORT || 7878),
    host: process.env.HOST || "127.0.0.1",
    dataDir: resolveDir(process.env.DATA_DIR, "data"),
    storageDir: resolveDir(process.env.STORAGE_DIR, "storage"),
    masterKey: process.env.APP_MASTER_KEY || "",
    workerMode: process.env.WORKER_MODE === "off" ? "off" : "inline",
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
    editInboxDir: process.env.EDIT_INBOX_DIR || "",
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
    tickMs: Number(process.env.SCHEDULER_TICK_MS || 1000),
    ...overrides,
  };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.storageDir, { recursive: true });
  return cfg;
}
