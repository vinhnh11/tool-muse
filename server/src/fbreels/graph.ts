import fs from "node:fs";
import { redact, sleep as realSleep } from "../util.ts";

/** token/permission: lỗi xác thực-quyền (tạm dừng hàng đợi). rate_limit/network/server: tạm thời (được thử lại ở bước start/upload). */
export type GraphErrorKind = "token" | "rate_limit" | "permission" | "network" | "server" | "other";

/** Lỗi tạm thời, có thể thử lại an toàn trước bước finish */
export const isTransientKind = (k: GraphErrorKind): boolean => k === "rate_limit" || k === "network" || k === "server";

/** Lỗi cần người dùng can thiệp (token/quyền) */
export const isAuthKind = (k: GraphErrorKind): boolean => k === "token" || k === "permission";

/** Chỉ gửi token tới https + *.facebook.com / *.fbcdn.net */
export function isTrustedUploadUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h.endsWith(".facebook.com") || h.endsWith(".fbcdn.net");
  } catch {
    return false;
  }
}

export class GraphError extends Error {
  code: number | null;
  subcode: number | null;
  httpStatus: number;
  kind: GraphErrorKind;
  constructor(message: string, kind: GraphErrorKind, httpStatus = 0, code: number | null = null, subcode: number | null = null) {
    super(message);
    this.name = "GraphError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.code = code;
    this.subcode = subcode;
  }
}

export type ReelStatus = { state: "processing" | "ready" | "error"; message: string };

export interface GraphOptions {
  fetchImpl: typeof fetch;
  pageId: string;
  version: string;
  token: string;
  sleep?: (ms: number) => Promise<void>;
}

const API_TIMEOUT = 30_000;
const UPLOAD_TIMEOUT = 5 * 60_000;

/** Client Graph API cho Reels. Mỗi bước gọi ĐÚNG 1 lần, không tự retry. */
export class GraphReelsClient {
  private o: GraphOptions;
  private sleep: (ms: number) => Promise<void>;
  constructor(o: GraphOptions) {
    this.o = o;
    this.sleep = o.sleep ?? realSleep;
  }

  private scrub(text: string): string {
    return redact(text, [this.o.token]).replace(/EAA[A-Za-z0-9]{6,}/g, "***");
  }

  private authHeader(): string {
    return ["OAuth", this.o.token].join(" ");
  }

  private async call(url: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.o.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "TimeoutError" || err.name === "AbortError";
      throw new GraphError(timeout ? "Facebook không trả lời kịp (hết thời gian chờ)." : `Không kết nối được Facebook: ${this.scrub(err.message)}`, "network");
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    const fe = json.error as { message?: string; code?: number; error_subcode?: number; type?: string } | undefined;
    if (!res.ok || fe) {
      const code = typeof fe?.code === "number" ? fe.code : null;
      const subcode = typeof fe?.error_subcode === "number" ? fe.error_subcode : null;
      const raw = fe?.message ?? (text ? text.slice(0, 200) : `HTTP ${res.status}`);
      let kind: GraphErrorKind = "other";
      let msg = `Facebook báo lỗi${code ? ` (${code})` : ""}: ${raw}`;
      if (code === 190 || fe?.type === "OAuthException" && code === null) {
        kind = "token";
        msg = "Token Page hết hạn hoặc bị thu hồi, cập nhật trong Cấu hình.";
      } else if (code === 4 || code === 17 || code === 32 || code === 613 || res.status === 429) {
        kind = "rate_limit";
        msg = `Facebook giới hạn tần suất đăng (${code ?? 429}), thử lại sau. ${raw}`;
      } else if (code === 10 || code === 492 || (code !== null && code >= 200 && code <= 299)) {
        kind = "permission";
        msg = `Token thiếu quyền đăng lên Page (${code}): ${raw}`;
      } else if (code === 1 || code === 2 || res.status >= 500) {
        kind = "server";
        msg = `Facebook đang gặp sự cố tạm thời (${code ?? res.status}): ${raw}`;
      }
      throw new GraphError(this.scrub(msg), kind, res.status, code, subcode);
    }
    return json;
  }

  private get base(): string {
    return `https://graph.facebook.com/${this.o.version}`;
  }

  /** Bước 1: mở phiên upload */
  async startUpload(): Promise<{ videoId: string; uploadUrl: string }> {
    const j = await this.call(
      `${this.base}/${this.o.pageId}/video_reels`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upload_phase: "start", access_token: this.o.token }) },
      API_TIMEOUT,
    );
    const videoId = j.video_id ? String(j.video_id) : "";
    if (!videoId) throw new GraphError("Facebook không trả video_id ở bước bắt đầu.", "other");
    const uploadUrl = j.upload_url ? String(j.upload_url) : `https://rupload.facebook.com/video-upload/${this.o.version}/${videoId}`;
    return { videoId, uploadUrl };
  }

  /** Bước 2: upload nguyên file (offset 0) lên rupload. Đọc cả file vào RAM (Reels ≤ 90s). */
  async uploadFile(uploadUrl: string, filePath: string): Promise<void> {
    if (!isTrustedUploadUrl(uploadUrl)) throw new GraphError("Địa chỉ upload do Facebook trả về không hợp lệ (không phải https *.facebook.com / *.fbcdn.net); không gửi token.", "other");
    const buf = fs.readFileSync(filePath);
    await this.call(
      uploadUrl,
      { method: "POST", headers: { Authorization: this.authHeader(), offset: "0", file_size: String(buf.length), "Content-Type": "application/octet-stream" }, body: buf },
      UPLOAD_TIMEOUT,
    );
  }

  /** Bước 3: hoàn tất + đăng công khai */
  async finish(videoId: string, caption: string): Promise<{ success: boolean; postId: string | null }> {
    const j = await this.call(
      `${this.base}/${this.o.pageId}/video_reels`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: caption, access_token: this.o.token }),
      },
      API_TIMEOUT,
    );
    return { success: j.success !== false, postId: j.post_id ? String(j.post_id) : null };
  }

  /** Hỏi trạng thái xử lý của video */
  async getStatus(videoId: string): Promise<ReelStatus> {
    const j = await this.call(`${this.base}/${videoId}?fields=status`, { method: "GET", headers: { Authorization: this.authHeader() } }, API_TIMEOUT);
    const st = (j.status ?? {}) as { video_status?: string; publishing_phase?: { status?: string; error?: { message?: string } }; processing_phase?: { status?: string; error?: { message?: string } }; uploading_phase?: { status?: string; error?: { message?: string } } };
    const vs = String(st.video_status ?? "").toLowerCase();
    const phaseErr = st.publishing_phase?.error?.message ?? st.processing_phase?.error?.message ?? st.uploading_phase?.error?.message;
    if (vs === "error" || phaseErr || st.publishing_phase?.status === "error") return { state: "error", message: this.scrub(phaseErr ?? "Facebook báo video xử lý lỗi.") };
    if (vs === "ready" || (st.publishing_phase?.status === "complete" && vs !== "processing")) return { state: "ready", message: "" };
    return { state: "processing", message: vs || "processing" };
  }

  /** Polling HỮU HẠN; hết hạn thì ném lỗi (không vòng vô hạn) */
  async waitUntilReady(videoId: string, opts: { maxMs?: number; everyMs?: number } = {}): Promise<void> {
    const maxMs = opts.maxMs ?? 10 * 60_000;
    const everyMs = opts.everyMs ?? 15_000;
    let waited = 0;
    for (;;) {
      const s = await this.getStatus(videoId);
      if (s.state === "ready") return;
      if (s.state === "error") throw new GraphError(`Facebook xử lý video lỗi: ${s.message}`, "other");
      if (waited >= maxMs) throw new GraphError("Facebook chưa xử lý xong trong 10 phút. Có thể vẫn đang xử lý; kiểm tra Page trước khi Đăng lại.", "other");
      await this.sleep(everyMs);
      waited += everyMs;
    }
  }

  /** Kiểm tra token + Page ID: GET /{page-id}?fields=name,id */
  async pageInfo(): Promise<{ id: string; name: string }> {
    const j = await this.call(`${this.base}/${this.o.pageId}?fields=name,id`, { method: "GET", headers: { Authorization: this.authHeader() } }, API_TIMEOUT);
    return { id: String(j.id ?? this.o.pageId), name: String(j.name ?? "") };
  }
}
