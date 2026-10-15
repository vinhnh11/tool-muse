import { useEffect, useState } from "react";
import { BrainCircuit, Check, ClipboardCopy, KeyRound, ScrollText, Server, ShieldAlert, Terminal, Trash2 } from "lucide-react";
import { api, asApiError, type ApiError, type AuditEntry } from "../api";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { useDialogs } from "../components/ConfirmDialog";
import { Banner, EmptyState, ErrorBanner, Loading } from "../components/EmptyState";
import { Field, Input } from "../components/Field";
import { Modal } from "../components/Modal";
import { toastApiError, useToast } from "../components/Toast";
import { useApi } from "../hooks/useApi";
import { fmtDate, truncate } from "../labels";

function CopyButton({ text, label = "Sao chép" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1800);
  };
  return (
    <Button size="sm" icon={done ? <Check size={14} /> : <ClipboardCopy size={14} />} onClick={() => void copy()}>
      {done ? "Đã chép" : label}
    </Button>
  );
}

function LlmCard() {
  const toast = useToast();
  const s = useApi(() => api.llmSettings(), []);
  const [baseUrl, setBaseUrl] = useState("");
  const [textModel, setTextModel] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [audioModel, setAudioModel] = useState("");
  const [changeKey, setChangeKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!s.data) return;
    setBaseUrl(s.data.baseUrl);
    setTextModel(s.data.textModel);
    setVisionModel(s.data.visionModel);
    setAudioModel(s.data.audioModel);
    setChangeKey(!s.data.hasApiKey);
  }, [s.data]);

  const save = async (opts: { clearKey?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveLlmSettings({
        baseUrl: baseUrl.trim(),
        textModel: textModel.trim(),
        visionModel: visionModel.trim(),
        audioModel: audioModel.trim(),
        ...(opts.clearKey ? { apiKey: null } : changeKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      s.setData(r);
      setApiKey("");
      toast.success("Đã lưu cấu hình LLM");
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <BrainCircuit size={16} aria-hidden /> LLM gateway (suy luận)
        </div>
        {s.data ? s.data.baseUrl && s.data.textModel ? <Badge tone="success">Đã cấu hình</Badge> : <Badge tone="warning">Chưa cấu hình</Badge> : null}
      </div>
      <p className="muted small">
        Dùng cho phân tích video, sinh prompt bằng AI và Trợ lý AI. Hỗ trợ mọi gateway chuẩn OpenAI (vd 9Router: <code>http://host:20128/v1</code>). LLM chỉ suy luận - video do provider video tạo.
      </p>
      {s.error ? <ErrorBanner error={s.error} onRetry={s.reload} /> : null}
      {s.loading ? <Loading /> : null}
      {s.data ? (
        <div className="form-grid">
          <Field label="Base URL" hint="Phải bắt đầu bằng http:// hoặc https://">
            <Input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:20128/v1" />
          </Field>
          <div className="field">
            <span className="field-label">API key</span>
            {s.data.hasApiKey && !changeKey ? (
              <div className="key-row">
                <Badge tone="success">
                  <KeyRound size={12} /> Đã lưu key
                </Badge>
                <span className="muted small">Không bao giờ hiển thị lại.</span>
                <span className="spacer" />
                <Button size="sm" onClick={() => setChangeKey(true)}>
                  Đổi key
                </Button>
                <Button size="sm" variant="ghost" loading={busy} onClick={() => void save({ clearKey: true })}>
                  Xóa key
                </Button>
              </div>
            ) : (
              <div className="key-row">
                <Input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.data.hasApiKey ? "Nhập key mới" : "Dán API key (nếu gateway yêu cầu)"} />
                {s.data.hasApiKey ? (
                  <Button size="sm" variant="ghost" onClick={() => (setChangeKey(false), setApiKey(""))}>
                    Giữ key cũ
                  </Button>
                ) : null}
              </div>
            )}
          </div>
          <div className="grid-3">
            <Field label="Model chữ (text)" hint="Tổng hợp, sinh prompt, trợ lý">
              <Input className="mono" value={textModel} onChange={(e) => setTextModel(e.target.value)} placeholder="vd: gpt-4.1-mini" />
            </Field>
            <Field label="Model xem hình (vision)" hint="Đọc khung hình video tham khảo">
              <Input className="mono" value={visionModel} onChange={(e) => setVisionModel(e.target.value)} placeholder="vd: gpt-4.1" />
            </Field>
            <Field label="Model nghe (audio)" hint="Để trống = KHÔNG phân tích âm thanh (kết quả ghi rõ “chưa phân tích âm thanh”)">
              <Input className="mono" value={audioModel} onChange={(e) => setAudioModel(e.target.value)} placeholder="vd: gpt-4o-audio-preview" />
            </Field>
          </div>
          <ErrorBanner error={error} />
          <div className="row-end">
            {s.data.updatedAt ? <span className="muted small">Cập nhật {fmtDate(s.data.updatedAt)}</span> : null}
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Lưu cấu hình LLM
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TokensCard() {
  const toast = useToast();
  const dialogs = useDialogs();
  const tokens = useApi(() => api.tokens().then((r) => r.tokens), []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ token: string; note: string; name: string } | null>(null);
  const origin = window.location.origin;

  const create = async () => {
    setBusy(true);
    try {
      const n = name.trim() || "hermes";
      const r = await api.createToken(n);
      setCreated({ token: r.token, note: r.note, name: n });
      setName("");
      await tokens.reload();
    } catch (e) {
      toastApiError(toast, "Không tạo được token", e);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string, n: string) => {
    if (!(await dialogs.confirm({ title: `Thu hồi token “${n}”?`, body: "Agent/CLI đang dùng token này sẽ mất quyền truy cập ngay.", confirmLabel: "Thu hồi", danger: true }))) return;
    try {
      await api.revokeToken(id);
      toast.success("Đã thu hồi token");
      await tokens.reload();
    } catch (e) {
      toastApiError(toast, "Không thu hồi được", e);
    }
  };

  const mcpSnippet = created
    ? JSON.stringify({ mcpServers: { "batch-video-studio": { command: "node", args: ["D:\\tool\\server\\src\\mcp.ts"], env: { BVS_URL: origin, BVS_TOKEN: created.token } } } }, null, 2)
    : "";

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <Terminal size={16} aria-hidden /> API token cho Hermes / CLI / MCP
        </div>
      </div>
      <p className="muted small">Token cho agent bên ngoài gọi cùng bộ công cụ video_* qua REST/MCP. Agent vẫn phải được bạn xác nhận chi phí trước khi chạy batch.</p>
      <div className="key-row">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên token, vd: hermes-laptop" onKeyDown={(e) => e.key === "Enter" && void create()} />
        <Button variant="primary" loading={busy} onClick={() => void create()}>
          Tạo token
        </Button>
      </div>
      {tokens.error ? <ErrorBanner error={tokens.error} onRetry={tokens.reload} /> : null}
      {tokens.data && !tokens.data.length ? <EmptyState compact title="Chưa có token nào" /> : null}
      {tokens.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tên</th>
                <th>Tạo lúc</th>
                <th>Dùng lần cuối</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id}>
                  <td data-label="Tên">
                    <strong>{t.name}</strong> <code className="tiny muted">{t.id}</code>
                  </td>
                  <td data-label="Tạo lúc">{fmtDate(t.created_at)}</td>
                  <td data-label="Dùng lần cuối">{t.last_used_at ? fmtDate(t.last_used_at) : <span className="muted">chưa dùng</span>}</td>
                  <td className="col-actions">
                    <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => void revoke(t.id, t.name)}>
                      Thu hồi
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {created ? (
        <Modal open size="lg" title={`Token “${created.name}” đã tạo`} onClose={() => setCreated(null)} footer={<Button variant="primary" onClick={() => setCreated(null)}>Tôi đã lưu token</Button>}>
          <Banner tone="warning" icon={<ShieldAlert size={16} />} title="Chỉ hiện MỘT lần">
            {created.note} Đóng hộp này là không xem lại được.
          </Banner>
          <div className="secret-box">
            <code className="mono">{created.token}</code>
            <CopyButton text={created.token} label="Sao chép token" />
          </div>
          <div className="field-label">Cấu hình MCP (Hermes / Claude Code...)</div>
          <pre className="code-block">{mcpSnippet}</pre>
          <div className="row-end">
            <CopyButton text={mcpSnippet} label="Sao chép cấu hình MCP" />
          </div>
          <p className="muted small">
            Lệnh: <code>node D:\tool\server\src\mcp.ts</code> với biến môi trường <code>BVS_URL={origin}</code> và <code>BVS_TOKEN=&lt;token&gt;</code>. Nếu agent chạy trên máy khác, đổi BVS_URL thành địa chỉ máy chủ thật.
          </p>
        </Modal>
      ) : null}
    </section>
  );
}

function SystemCard() {
  const s = useApi(() => api.systemInfo(), []);
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <Server size={16} aria-hidden /> Hệ thống
        </div>
      </div>
      {s.error ? <ErrorBanner error={s.error} onRetry={s.reload} /> : null}
      {s.data ? (
        <dl className="kv">
          <dt>Chế độ worker</dt>
          <dd>
            <code>{s.data.workerMode}</code> {s.data.workerMode === "inline" ? <span className="muted small">(chạy cùng tiến trình web)</span> : null}
          </dd>
          <dt>Thư mục chỉnh sửa (EDIT_INBOX_DIR)</dt>
          <dd>{s.data.editInboxConfigured ? <Badge tone="success">Đã cấu hình</Badge> : <Badge tone="muted">Chưa cấu hình - nút “Đưa sang chỉnh sửa” sẽ báo lỗi</Badge>}</dd>
          <dt>Webhook (PUBLIC_BASE_URL)</dt>
          <dd>{s.data.webhookBaseConfigured ? <Badge tone="success">Đã cấu hình</Badge> : <Badge tone="muted">Chưa cấu hình - dùng poll định kỳ</Badge>}</dd>
        </dl>
      ) : s.loading ? (
        <Loading />
      ) : null}
    </section>
  );
}

function AuditCard() {
  const audit = useApi(() => api.audit().then((r) => r.entries), []);
  const [limit, setLimit] = useState(50);
  const fmtData = (e: AuditEntry) => {
    if (!e.data_json) return "";
    try {
      return truncate(
        Object.entries(JSON.parse(e.data_json) as Record<string, unknown>)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join(" · "),
        160,
      );
    } catch {
      return truncate(e.data_json, 160);
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <ScrollText size={16} aria-hidden /> Nhật ký thao tác (audit)
        </div>
        <Button size="sm" variant="ghost" onClick={() => void audit.reload()}>
          Tải lại
        </Button>
      </div>
      {audit.error ? <ErrorBanner error={audit.error} onRetry={audit.reload} /> : null}
      {audit.loading ? <Loading /> : null}
      {audit.data && !audit.data.length ? <EmptyState compact title="Chưa có thao tác nào" /> : null}
      {audit.data?.length ? (
        <>
          <div className="table-wrap">
            <table className="table audit-table">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Nguồn</th>
                  <th>Hành động</th>
                  <th>Đối tượng</th>
                  <th>Dữ liệu</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.slice(0, limit).map((e) => (
                  <tr key={e.id}>
                    <td data-label="Thời gian" className="nowrap small">
                      {fmtDate(e.created_at)}
                    </td>
                    <td data-label="Nguồn">
                      <Badge tone={e.actor === "ui" ? "neutral" : e.actor === "chat" ? "violet" : "info"}>{e.actor}</Badge>
                    </td>
                    <td data-label="Hành động">
                      <code className="tiny">{e.action}</code>
                    </td>
                    <td data-label="Đối tượng" className="small">
                      {e.target_type ? `${e.target_type} ` : ""}
                      {e.target_id ? <code className="tiny">{truncate(e.target_id, 40)}</code> : null}
                    </td>
                    <td data-label="Dữ liệu" className="small muted">
                      {fmtData(e)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.data.length > limit ? (
            <div className="row-end">
              <Button size="sm" onClick={() => setLimit(limit + 100)}>
                Xem thêm ({audit.data.length - limit})
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function SettingsPage() {
  return (
    <div className="page-stack">
      <LlmCard />
      <TokensCard />
      <SystemCard />
      <AuditCard />
    </div>
  );
}
