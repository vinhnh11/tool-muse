import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.ts";

/**
 * Mã hóa secret (API key provider, key LLM, webhook secret) bằng AES-256-GCM.
 * Khóa chủ: APP_MASTER_KEY (base64 32 byte) hoặc file data/master.key tự sinh.
 * Secret giải mã CHỈ dùng trong server khi gọi provider - không bao giờ trả về API.
 */
export class SecretBox {
  private key: Buffer;

  constructor(cfg: AppConfig) {
    this.key = SecretBox.loadKey(cfg);
  }

  static loadKey(cfg: AppConfig): Buffer {
    if (cfg.masterKey) {
      const k = Buffer.from(cfg.masterKey, "base64");
      if (k.length !== 32) throw new Error("APP_MASTER_KEY phải là 32 byte mã hóa base64.");
      return k;
    }
    const file = path.join(cfg.dataDir, "master.key");
    if (fs.existsSync(file)) {
      const k = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
      if (k.length === 32) return k;
      throw new Error(`File khóa chủ ${file} hỏng (không phải 32 byte base64).`);
    }
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, k.toString("base64"), { mode: 0o600 });
    return k;
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
  }

  decrypt(blob: string | null | undefined): string {
    if (!blob) return "";
    const [v, ivB, tagB, encB] = blob.split(":");
    if (v !== "v1" || !ivB || !tagB || encB === undefined) throw new Error("Secret hỏng hoặc sai định dạng.");
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(encB, "base64")), d.final()]).toString("utf8");
  }
}

/** Băm mật khẩu bằng scrypt (salt ngẫu nhiên) */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltB, hashB] = stored.split(":");
  if (alg !== "scrypt" || !saltB || !hashB) return false;
  const expected = Buffer.from(hashB, "base64");
  const got = crypto.scryptSync(password, Buffer.from(saltB, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}
