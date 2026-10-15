import type { Db } from "./db.ts";
import type { SecretBox } from "./secrets.ts";
import { AppError, nowIso, redact, safeJsonParse } from "./util.ts";
import type { ZodTypeAny, output } from "zod";

/**
 * LLM gateway (chuẩn OpenAI /v1/chat/completions - vd 9Router, OpenRouter, LiteLLM).
 * Dùng để SUY LUẬN (phân tích video, sinh prompt, chat điều phối) - KHÔNG phải
 * video generator. Không có fallback: chưa cấu hình → báo lỗi rõ.
 */
export interface LlmSettings {
  baseUrl: string;
  textModel: string;
  visionModel: string;
  /** Model nghe được audio (part input_audio). Trống = không phân tích âm thanh. */
  audioModel: string;
  hasApiKey: boolean;
  updatedAt: string | null;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}

const KEY = "llm";

export class LlmService {
  private db: Db;
  private secrets: SecretBox;
  private fetchImpl: typeof fetch;

  constructor(db: Db, secrets: SecretBox, fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.secrets = secrets;
    this.fetchImpl = fetchImpl;
  }

  getSettings(workspaceId: string): LlmSettings {
    const r = this.db.get<{ value_json: string; secret_enc: string | null; updated_at: string }>("SELECT value_json, secret_enc, updated_at FROM settings WHERE workspace_id = ? AND key = ?", workspaceId, KEY);
    const v = safeJsonParse<Partial<LlmSettings>>(r?.value_json, {});
    return {
      baseUrl: v.baseUrl ?? "",
      textModel: v.textModel ?? "",
      visionModel: v.visionModel ?? "",
      audioModel: v.audioModel ?? "",
      hasApiKey: Boolean(r?.secret_enc),
      updatedAt: r?.updated_at ?? null,
    };
  }

  saveSettings(workspaceId: string, patch: { baseUrl?: string; textModel?: string; visionModel?: string; audioModel?: string; apiKey?: string | null }): LlmSettings {
    const cur = this.getSettings(workspaceId);
    const r = this.db.get<{ secret_enc: string | null }>("SELECT secret_enc FROM settings WHERE workspace_id = ? AND key = ?", workspaceId, KEY);
    const value = {
      baseUrl: (patch.baseUrl ?? cur.baseUrl).trim(),
      textModel: (patch.textModel ?? cur.textModel).trim(),
      visionModel: (patch.visionModel ?? cur.visionModel).trim(),
      audioModel: (patch.audioModel ?? cur.audioModel).trim(),
    };
    if (value.baseUrl && !/^https?:\/\//.test(value.baseUrl)) throw new AppError("INVALID_URL", "Địa chỉ LLM gateway phải bắt đầu bằng http:// hoặc https://", 400);
    const secret = patch.apiKey === undefined ? (r?.secret_enc ?? null) : patch.apiKey ? this.secrets.encrypt(patch.apiKey.trim()) : null;
    this.db.run(
      `INSERT INTO settings (workspace_id, key, value_json, secret_enc, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, secret_enc = excluded.secret_enc, updated_at = excluded.updated_at`,
      workspaceId,
      KEY,
      JSON.stringify(value),
      secret,
      nowIso(),
    );
    return this.getSettings(workspaceId);
  }

  private resolved(workspaceId: string): { baseUrl: string; apiKey: string; s: LlmSettings } {
    const s = this.getSettings(workspaceId);
    if (!s.baseUrl) throw new AppError("LLM_NOT_CONFIGURED", "Chưa cấu hình LLM gateway (Cài đặt → LLM). Tính năng này cần một model suy luận.", 409);
    const r = this.db.get<{ secret_enc: string | null }>("SELECT secret_enc FROM settings WHERE workspace_id = ? AND key = ?", workspaceId, KEY);
    return { baseUrl: s.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""), apiKey: r?.secret_enc ? this.secrets.decrypt(r.secret_enc) : "", s };
  }

  model(workspaceId: string, kind: "text" | "vision" | "audio"): string {
    const s = this.getSettings(workspaceId);
    if (!s.baseUrl) throw new AppError("LLM_NOT_CONFIGURED", "Chưa cấu hình LLM gateway (Cài đặt → LLM). Tính năng này cần một model suy luận.", 409);
    const m = kind === "text" ? s.textModel : kind === "vision" ? s.visionModel : s.audioModel;
    if (!m) {
      if (kind === "audio") return "";
      throw new AppError(`LLM_${kind.toUpperCase()}_MODEL_NOT_CONFIGURED`, kind === "text" ? "Chưa chọn model chữ (Cài đặt → LLM)." : "Chưa chọn model xem hình (Cài đặt → LLM).", 409);
    }
    return m;
  }

  async chat(workspaceId: string, req: { model: string; messages: ChatMessage[]; tools?: ToolSpec[]; json?: boolean; temperature?: number; maxTokens?: number }): Promise<ChatResult> {
    const { baseUrl, apiKey } = this.resolved(workspaceId);
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: false };
    if (req.tools?.length) body.tools = req.tools;
    if (req.json) body.response_format = { type: "json_object" };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch (e) {
      throw new AppError("LLM_UNAVAILABLE", `LLM gateway không trả lời: ${redact((e as Error).message, [apiKey])}`, 502);
    }
    const text = await res.text();
    if (!res.ok) {
      const status = res.status === 404 ? 409 : 502;
      throw new AppError(res.status === 404 ? "LLM_MODEL_NOT_SUPPORTED" : "LLM_ERROR", `LLM gateway lỗi ${res.status}: ${redact(text.slice(0, 300), [apiKey])}`, status);
    }
    const j = safeJsonParse<{ choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]; usage?: ChatResult["usage"] }>(text, {});
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new AppError("LLM_BAD_RESPONSE", "LLM gateway trả dữ liệu không đúng chuẩn OpenAI chat completions.", 502);
    return {
      content: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
      usage: j.usage ?? null,
    };
  }

  /** Gọi model, ép trả JSON, kiểm bằng zod; sai thì nhờ model sửa MỘT lần */
  async json<S extends ZodTypeAny>(workspaceId: string, req: { model: string; system: string; user: string | ChatContentPart[]; schema: S; temperature?: number; maxTokens?: number }): Promise<output<S>> {
    const messages: ChatMessage[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.chat(workspaceId, { model: req.model, messages, json: true, temperature: req.temperature, maxTokens: req.maxTokens });
      const parsed = parseJsonLoose(r.content);
      const check = req.schema.safeParse(parsed);
      if (check.success) return check.data as output<S>;
      messages.push({ role: "assistant", content: r.content });
      messages.push({ role: "user", content: `JSON chưa đúng schema: ${check.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Trả lại DUY NHẤT JSON đúng schema.` });
    }
    throw new AppError("LLM_BAD_JSON", "Model không trả JSON đúng cấu trúc sau 2 lần.", 502);
  }
}

export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(t.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
