import crypto from "node:crypto";

export const nowIso = (): string => new Date().toISOString();
export const nowMs = (): number => Date.now();

/** Id ngắn, sắp được theo thời gian: <prefix>_<time36><rand> */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`;
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Lỗi nghiệp vụ có mã + HTTP status, câu tiếng Việt cho người dùng */
export class AppError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Che secret trước khi ghi log / trả lỗi: query string của URL (signed URL),
 * bearer token, các cặp key=value giống api key, và mọi secret biết trước.
 */
export function redact(text: string, secrets: string[] = []): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("***");
  }
  return out
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, "$1?…")
    .replace(/(bearer|basic)\s+[^\s"',}]+/gi, "$1 ***")
    .replace(/(authorization|api[-_]?key|token|secret|password)(["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\s)[^\s"',}]+/gi, "$1$2***");
}

/** Chuẩn hóa chữ để so trùng prompt: thường, bỏ dấu câu, gộp khoảng trắng */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Độ giống Jaccard trên tập 3-gram từ (0..1) - dùng phát hiện prompt gần trùng */
export function similarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const w = normalizeText(s).split(" ").filter(Boolean);
    const set = new Set<string>();
    if (w.length < 3) {
      for (const x of w) set.add(x);
      return set;
    }
    for (let i = 0; i + 2 < w.length; i++) set.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Thời lượng ghi trong prompt ("dài 12 giây", "7-second", "duration: 9s"). Bỏ qua mốc kiểu "0-2s:" và số ngoài [min,max]. */
export function durationFromPrompt(prompt: string, min = 3, max = 15): number | null {
  const m =
    prompt.match(/(?:dài|kéo dài|thời lượng|duration|length|long)\s*:?\s*(\d{1,2})\s*(?:giây|giay|s\b|sec|seconds)/i) ??
    prompt.match(/(?<![\d-])(\d{1,2})[-\s]?(?:giây|giay|seconds?|sec)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= min && n <= max ? n : null;
}
