import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, FileText, Film, Loader2, Paperclip, Plus, Send, Sparkles, User, X } from "lucide-react";
import { api, asApiError, type ApiError, type ChatMessage } from "../api";
import { Button, IconButton } from "../components/Button";
import { EmptyState, ErrorBanner } from "../components/EmptyState";
import { Checkbox, Select } from "../components/Field";
import { FilterChip, Segmented } from "../components/Tabs";
import { useToast } from "../components/Toast";
import { useApi, useLocalStorage } from "../hooks/useApi";
import { truncate } from "../labels";
import { useStudio } from "../state/studio";
import { ToolCard, toolLabel } from "./ChatCards";
import { MiniMarkdown } from "./markdown";

const EXAMPLE = "Phân tích 6 video này, tạo 50 prompt theo phong cách tương tự, mỗi video 30 giây, cho tôi duyệt trước khi chạy";

function UserBubble({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const long = m.content.length > 700;
  return (
    <div className="msg msg-user">
      <div className="msg-bubble">
        <div className="msg-text">{long && !open ? truncate(m.content, 700) : m.content}</div>
        {long ? (
          <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
            {open ? "Thu gọn" : "Xem đủ"}
          </button>
        ) : null}
      </div>
      <span className="msg-avatar" aria-hidden>
        <User size={13} />
      </span>
    </div>
  );
}

function AssistantBubble({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const calls = m.toolCalls ?? [];
  if (!m.content.trim() && !calls.length) return null;
  return (
    <div className="msg msg-assistant">
      <span className="msg-avatar is-bot" aria-hidden>
        <Bot size={13} />
      </span>
      <div className="msg-bubble">
        {m.content.trim() ? <MiniMarkdown text={m.content} /> : null}
        {calls.length ? (
          <div className="tool-calls">
            <button type="button" className="tool-calls-head" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Đã gọi: {calls.map((c) => toolLabel(c.name)).join(", ")}
            </button>
            {open ? (
              <pre className="code-block">
                {calls
                  .map((c) => {
                    let args = c.arguments;
                    try {
                      args = JSON.stringify(JSON.parse(c.arguments), null, 2);
                    } catch {
                      /* giữ nguyên */
                    }
                    return `${c.name}(${args})`;
                  })
                  .join("\n\n")}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { sessionId, session, createSession, providers } = useStudio();
  const toast = useToast();
  const history = useApi(() => (sessionId ? api.chatHistory(sessionId).then((r) => r.messages) : Promise.resolve([] as ChatMessage[])), [sessionId]);
  const skills = useApi(() => api.skills().then((r) => r.skills), []);
  const refs = useApi(() => (sessionId ? api.assets({ kind: "reference", sessionId }).then((r) => r.assets) : Promise.resolve([])), [sessionId]);

  const [mode, setMode] = useLocalStorage<"auto" | "manual">("bvs.chat.mode", "auto");
  const [skillIds, setSkillIds] = useLocalStorage<string[]>("bvs.chat.skills", []);
  const [providerId, setProviderId] = useLocalStorage<string>("bvs.chat.provider", "");
  const [modelId, setModelId] = useLocalStorage<string>("bvs.chat.model", "");
  const [text, setText] = useState("");
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [file, setFile] = useState<{ fileName: string; content: string } | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [showControls, setShowControls] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const enabledProviders = providers.filter((p) => p.enabled);
  const provider = enabledProviders.find((p) => p.id === providerId) ?? null;
  const models = provider?.capabilities.models ?? [];

  useEffect(() => {
    setAssetIds([]);
    setFile(null);
    setError(null);
    setPending(null);
  }, [sessionId]);

  const messages = useMemo(() => history.data ?? [], [history.data]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, sending]);

  const send = async () => {
    if (!sessionId || sending) return;
    const msg = text.trim();
    if (!msg && !file) return;
    setSending(true);
    setError(null);
    setPending(msg || `[Đính kèm ${file?.fileName}]`);
    setText("");
    try {
      const r = await api.sendChat(sessionId, {
        message: msg,
        mode,
        ...(mode === "manual" ? { skillIds, providerConfigId: provider?.id, modelId: provider ? modelId || undefined : undefined } : {}),
        attachments: assetIds.length || file ? { assetIds: assetIds.length ? assetIds : undefined, text: file ?? undefined } : undefined,
      });
      history.setData((prev) => [...(prev ?? []), ...r.messages]);
      setAssetIds([]);
      setFile(null);
    } catch (e) {
      const err = asApiError(e);
      setError(err);
      if (!msg) setText("");
      else setText((t) => t || msg);
      void history.reload();
    } finally {
      setPending(null);
      setSending(false);
    }
  };

  const attachFile = async (f: File) => {
    if (f.size > 2 * 1024 * 1024) return toast.error("File quá lớn", "Tối đa 2MB văn bản.");
    setFile({ fileName: f.name, content: await f.text() });
  };

  if (!sessionId) {
    return (
      <div className="chat">
        <div className="chat-head">
          <div className="chat-title">
            <Sparkles size={15} aria-hidden /> Trợ lý AI
          </div>
          <IconButton label="Đóng" icon={<X size={15} />} onClick={onClose} />
        </div>
        <EmptyState
          icon={<Bot size={22} />}
          title="Cần một phiên làm việc"
          description="Mỗi phiên có lịch sử chat, video tham khảo và batch riêng."
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => void createSession().catch((e) => toast.error("Không tạo được phiên", asApiError(e).message))}>
              Tạo phiên
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="chat-title">
          <Sparkles size={15} aria-hidden /> <span title={session ? `Phiên: ${session.title}` : undefined}>Trợ lý AI</span>
        </div>
        <Segmented
          ariaLabel="Chế độ trợ lý"
          value={mode}
          onChange={(v) => {
            setMode(v);
            if (v === "manual") setShowControls(true);
          }}
          options={[
            { id: "auto", label: "Tự động", title: "Trợ lý tự chọn skill và provider/model phù hợp" },
            { id: "manual", label: "Thủ công", title: "Dùng đúng skill + provider/model bạn chọn" },
          ]}
        />
        <IconButton label="Đóng" icon={<X size={15} />} onClick={onClose} />
      </div>

      {mode === "manual" ? (
        <div className="chat-controls">
          <button type="button" className="tool-calls-head" onClick={() => setShowControls(!showControls)} aria-expanded={showControls}>
            {showControls ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Skill: {skillIds.length ? skillIds.length : "chưa chọn"} · Provider: {provider ? provider.name : "chưa chọn"}
          </button>
          {showControls ? (
            <>
              <div className="chip-row">
                {(skills.data ?? []).map((s) => (
                  <FilterChip key={s.id} active={skillIds.includes(s.id)} onClick={() => setSkillIds(skillIds.includes(s.id) ? skillIds.filter((x) => x !== s.id) : [...skillIds, s.id])}>
                    <span title={s.description}>{s.name}</span>
                  </FilterChip>
                ))}
              </div>
              <div className="grid-2">
                <Select
                  className="input-sm"
                  aria-label="Provider"
                  value={provider?.id ?? ""}
                  onChange={(e) => {
                    setProviderId(e.target.value);
                    setModelId("");
                  }}
                  options={[{ value: "", label: "- Provider -" }, ...enabledProviders.map((p) => ({ value: p.id, label: p.name }))]}
                />
                <Select className="input-sm" aria-label="Model" value={modelId} disabled={!provider} onChange={(e) => setModelId(e.target.value)} options={[{ value: "", label: "- Model mặc định -" }, ...models.map((m) => ({ value: m.modelId, label: m.label || m.modelId }))]} />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="chat-scroll" ref={scroller}>
        {history.error ? <ErrorBanner error={history.error} onRetry={history.reload} compact /> : null}
        {history.loading ? <div className="skeleton" style={{ height: 80 }} /> : null}
        {!history.loading && !messages.length && !pending ? (
          <div className="chat-empty">
            <Bot size={22} aria-hidden />
            <p>Trợ lý điều phối phân tích video, sinh prompt hàng loạt và tạo batch chờ duyệt. Trợ lý không bao giờ tự chạy việc tốn phí.</p>
            <button type="button" className="chat-example" onClick={() => setText(EXAMPLE)}>
              “{EXAMPLE}”
            </button>
          </div>
        ) : null}
        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} m={m} />
          ) : m.role === "assistant" ? (
            <AssistantBubble key={m.id} m={m} />
          ) : (
            <div key={m.id} className="msg msg-tool">
              <ToolCard msg={m} />
            </div>
          ),
        )}
        {pending ? (
          <div className="msg msg-user is-pending">
            <div className="msg-bubble">
              <div className="msg-text">{truncate(pending, 700)}</div>
            </div>
            <span className="msg-avatar" aria-hidden>
              <User size={13} />
            </span>
          </div>
        ) : null}
        {sending ? (
          <div className="msg msg-assistant">
            <span className="msg-avatar is-bot" aria-hidden>
              <Bot size={13} />
            </span>
            <div className="msg-bubble thinking">
              <Loader2 size={14} className="spin" /> Đang xử lý... <span className="muted tiny">(có thể mất 1-2 phút)</span>
            </div>
          </div>
        ) : null}
        {error ? <ErrorBanner error={error} compact title="Trợ lý chưa trả lời được" /> : null}
      </div>

      <div className="chat-compose">
        {assetIds.length || file ? (
          <div className="attach-row">
            {assetIds.map((id) => (
              <span key={id} className="attach-chip">
                <Film size={12} /> {truncate(refs.data?.find((a) => a.id === id)?.fileName ?? id, 24)}
                <button type="button" onClick={() => setAssetIds(assetIds.filter((x) => x !== id))} aria-label="Bỏ đính kèm">
                  <X size={11} />
                </button>
              </span>
            ))}
            {file ? (
              <span className="attach-chip">
                <FileText size={12} /> {truncate(file.fileName, 24)} ({file.content.split(/\r?\n/).filter((l) => l.trim()).length} dòng)
                <button type="button" onClick={() => setFile(null)} aria-label="Bỏ file">
                  <X size={11} />
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
        {showAttach ? (
          <div className="attach-pop">
            <div className="attach-pop-head">
              <strong className="small">Đính kèm video tham khảo của phiên</strong>
              <IconButton label="Đóng" icon={<X size={13} />} onClick={() => setShowAttach(false)} />
            </div>
            {refs.data && !refs.data.length ? <div className="muted small">Phiên chưa có video - tải lên ở trang Phân tích video.</div> : null}
            <div className="attach-list">
              {(refs.data ?? []).map((a) => (
                <Checkbox key={a.id} checked={assetIds.includes(a.id)} onChange={(on) => setAssetIds(on ? [...assetIds, a.id] : assetIds.filter((x) => x !== a.id))} label={truncate(a.fileName, 40)} />
              ))}
            </div>
            <Button size="sm" icon={<FileText size={14} />} onClick={() => fileInput.current?.click()}>
              Đính kèm file prompt TXT/CSV
            </Button>
          </div>
        ) : null}
        <textarea
          className="input textarea chat-input"
          rows={3}
          value={text}
          placeholder={`vd: ${EXAMPLE}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={sending}
          aria-label="Tin nhắn cho trợ lý"
        />
        <div className="chat-compose-bar">
          <IconButton label="Đính kèm" icon={<Paperclip size={15} />} onClick={() => setShowAttach(!showAttach)} />
          <span className="muted tiny">Enter để gửi · Shift+Enter xuống dòng</span>
          <span className="spacer" />
          <Button variant="primary" size="sm" icon={<Send size={14} />} loading={sending} disabled={!text.trim() && !file} onClick={() => void send()}>
            Gửi
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.csv,text/plain,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void attachFile(f);
            e.target.value = "";
            setShowAttach(false);
          }}
        />
      </div>
    </div>
  );
}
