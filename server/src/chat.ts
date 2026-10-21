import type { AppContext } from "./context.ts";
import type { ChatMessage } from "./llm.ts";
import { getSkills, listSkills, SessionService } from "./sessions.ts";
import { invokeTool, openAiTools } from "./tools.ts";
import { AppError, newId, nowIso, redact, safeJsonParse } from "./util.ts";

/**
 * CHAT AI điều phối (trong ứng dụng): LLM (qua LLM gateway, vd 9Router) gọi các
 * tool video_* để phân tích → sinh prompt → tạo batch CHỜ DUYỆT → theo dõi.
 * LLM chỉ suy luận; tạo video là việc của video provider; chạy là việc của worker.
 *
 * Chế độ:
 *  - manual: dùng ĐÚNG skill + provider/model người dùng chọn.
 *  - auto: trợ lý tự chọn skill phù hợp (từ danh mục) và provider/model trong số đã bật.
 */
const MAX_STEPS = 8;

interface MsgRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  created_at: string;
}

export function messageToPublic(r: MsgRow) {
  return {
    id: r.id,
    role: r.role as "user" | "assistant" | "tool",
    content: r.content,
    toolCalls: safeJsonParse<{ id: string; name: string; arguments: string }[] | null>(r.tool_calls_json, null),
    toolCallId: r.tool_call_id,
    toolName: r.tool_name,
    createdAt: r.created_at,
  };
}

export interface ChatOptions {
  mode?: "auto" | "manual";
  skillIds?: string[];
  providerConfigId?: string | null;
  modelId?: string | null;
  attachments?: { assetIds?: string[]; text?: { fileName: string; content: string } | null };
}

export class ChatService {
  private ctx: AppContext;
  private sessions: SessionService;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.sessions = new SessionService(ctx);
  }

  history(workspaceId: string, sessionId: string) {
    this.sessions.row(workspaceId, sessionId);
    return this.ctx.db.all<MsgRow>("SELECT * FROM chat_messages WHERE session_id = ? AND workspace_id = ? ORDER BY created_at, rowid", sessionId, workspaceId).map(messageToPublic);
  }

  private save(workspaceId: string, sessionId: string, m: { role: string; content: string; toolCalls?: unknown; toolCallId?: string; toolName?: string }): MsgRow {
    const id = newId("msg");
    const created = nowIso();
    this.ctx.db.run(
      "INSERT INTO chat_messages (id, workspace_id, session_id, role, content, tool_calls_json, tool_call_id, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      workspaceId,
      sessionId,
      m.role,
      m.content,
      m.toolCalls ? JSON.stringify(m.toolCalls) : null,
      m.toolCallId ?? null,
      m.toolName ?? null,
      created,
    );
    return this.ctx.db.get<MsgRow>("SELECT * FROM chat_messages WHERE id = ?", id)!;
  }

  private systemPrompt(workspaceId: string, sessionId: string, opts: ChatOptions): string {
    const session = this.sessions.get(workspaceId, sessionId);
    const mode = opts.mode ?? (session.skillMode === "manual" ? "manual" : "auto");
    const chosen = getSkills(opts.skillIds?.length ? opts.skillIds : session.skillIds);
    const catalog = listSkills();
    const providers = this.ctx.providers.list(workspaceId).filter((p) => p.enabled);
    const lines = [
      "Bạn là trợ lý điều phối AI Batch Video Studio. Trả lời TIẾNG VIỆT, ngắn gọn, rõ con số.",
      "Bạn có các tool video_* để: liệt kê/phân tích video tham khảo, sinh prompt hàng loạt, kiểm/ước tính, tạo batch, theo dõi, hủy, tạo lại, xuất ZIP.",
      "LUẬT BẮT BUỘC:",
      "1. Không bao giờ tự chạy việc tốn phí. video_create_batch chỉ tạo batch CHỜ DUYỆT; sau đó nêu số video + chi phí ước tính và bảo người dùng bấm 'Duyệt & chạy' trên giao diện.",
      "2. Người dùng chỉ yêu cầu lên ý tưởng/prompt → dừng ở bộ prompt chờ duyệt, KHÔNG tạo batch.",
      "3. Người dùng muốn duyệt trước → dừng ở bước duyệt.",
      "4. Phân tích video chạy nền: sau video_analyze, gọi video_get_analysis; nếu chưa xong thì báo tiến độ và đề nghị người dùng chờ rồi hỏi lại - không bịa kết quả.",
      "5. Không bịa: chỉ báo những gì tool trả về. Nếu coverage.audio khác 'analyzed' thì nói rõ CHƯA phân tích âm thanh.",
      "6. Trước khi chọn thông số, kiểm khả năng model bằng video_get_provider_capabilities. Model không hỗ trợ thời lượng/tỷ lệ → nói rõ và đề xuất phương án.",
      "7. Người dùng nói 'triển khai' / 'làm video từ bộ prompt này' → gọi video_deploy_prompt_set với promptSetId: MỖI PROMPT = 1 VIDEO (N prompt → N video), không nhân bản. Nếu ngay từ đầu người dùng yêu cầu 'phân tích → sinh N prompt → triển khai luôn' thì sinh xong gọi video_deploy_prompt_set ngay. Provider miễn phí chạy luôn; provider tính phí dừng ở CHỜ DUYỆT, nêu số video + chi phí.",
      `Chế độ: ${mode === "manual" ? "THỦ CÔNG - dùng đúng skill/provider/model người dùng đã chọn, không tự đổi." : "TỰ ĐỘNG - tự chọn skill phù hợp từ danh mục và provider/model trong số đang bật."}`,
      opts.providerConfigId ? `Provider người dùng chọn: ${opts.providerConfigId}${opts.modelId ? `, model ${opts.modelId}` : ""}.` : "",
      `Provider đang bật: ${providers.map((p) => `${p.id} (${p.name}, ${p.status}, model: ${p.capabilities.models.map((m) => m.modelId).join("/")}, giá: ${p.capabilities.pricing})`).join("; ") || "chưa có"}.`,
      `Phiên hiện tại: ${session.id} - "${session.title}".`,
    ];
    if (chosen.length) {
      lines.push("SKILL ĐANG ÁP DỤNG (quy trình phải theo):");
      for (const s of chosen) lines.push(`## ${s.name}\n${s.body}`);
    } else if (mode === "auto" && catalog.length) {
      lines.push("DANH MỤC SKILL (tự áp dụng skill khớp rõ với yêu cầu; không khớp thì không dùng):");
      for (const s of catalog) lines.push(`## ${s.id} - ${s.name}: ${s.description}\n${s.body}`);
    }
    return lines.filter(Boolean).join("\n");
  }

  async send(workspaceId: string, userId: string, sessionId: string, text: string, opts: ChatOptions = {}) {
    this.sessions.row(workspaceId, sessionId);
    if (!text.trim() && !opts.attachments?.text) throw new AppError("EMPTY_MESSAGE", "Tin nhắn trống.", 400);
    const model = this.ctx.llm.model(workspaceId, "text");
    let userContent = text.trim();
    if (opts.attachments?.assetIds?.length) userContent += `\n\n[Đính kèm assetId: ${opts.attachments.assetIds.join(", ")}]`;
    if (opts.attachments?.text) userContent += `\n\n[Đính kèm file ${opts.attachments.text.fileName} - dùng video_import_prompts với nội dung này]\n${opts.attachments.text.content.slice(0, 200_000)}`;
    const firstNew = this.save(workspaceId, sessionId, { role: "user", content: userContent });
    this.sessions.touch(sessionId);

    // Lịch sử gửi cho model (40 tin gần nhất)
    const hist = this.ctx.db.all<MsgRow>("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 40", sessionId).reverse();
    while (hist.length && hist[0]!.role === "tool") hist.shift();
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt(workspaceId, sessionId, opts) }];
    for (const h of hist) {
      if (h.role === "tool") messages.push({ role: "tool", content: h.content, tool_call_id: h.tool_call_id ?? "" });
      else if (h.role === "assistant") {
        const calls = safeJsonParse<{ id: string; name: string; arguments: string }[] | null>(h.tool_calls_json, null);
        messages.push({ role: "assistant", content: h.content || null, ...(calls?.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) } : {}) });
      } else messages.push({ role: "user", content: h.content });
    }

    const tools = openAiTools("chat");
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await this.ctx.llm.chat(workspaceId, { model, messages, tools, temperature: 0.3 });
      this.save(workspaceId, sessionId, { role: "assistant", content: r.content, toolCalls: r.toolCalls.length ? r.toolCalls : undefined });
      messages.push({ role: "assistant", content: r.content || null, ...(r.toolCalls.length ? { tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) } : {}) });
      if (!r.toolCalls.length) break;
      for (const call of r.toolCalls) {
        let result: unknown;
        try {
          result = await invokeTool(this.ctx, { workspaceId, userId, channel: "chat", sessionId }, call.name, safeJsonParse(call.arguments, {}));
        } catch (e) {
          const err = e as AppError;
          result = { error: { code: err.code ?? "ERROR", message: redact(err.message), details: err.details } };
        }
        const content = JSON.stringify(result).slice(0, 30_000);
        this.save(workspaceId, sessionId, { role: "tool", content, toolCallId: call.id, toolName: call.name });
        messages.push({ role: "tool", content, tool_call_id: call.id });
      }
    }
    const firstRowid = Number(this.ctx.db.get<{ r: number }>("SELECT rowid AS r FROM chat_messages WHERE id = ?", firstNew.id)?.r ?? 0);
    const newRows = this.ctx.db.all<MsgRow>("SELECT * FROM chat_messages WHERE session_id = ? AND rowid >= ? ORDER BY rowid", sessionId, firstRowid);
    return newRows.map(messageToPublic);
  }
}
