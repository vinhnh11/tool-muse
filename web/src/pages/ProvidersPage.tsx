import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Pencil, Plug, PlugZap, Plus, Power, PowerOff, XCircle } from "lucide-react";
import { api, asApiError, type ApiError, type ProviderConfig, type ProviderInput, type ProviderType } from "../api";
import { Badge, MockBadge, ProviderStatusBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { useDialogs } from "../components/ConfirmDialog";
import { Banner, EmptyState, ErrorBanner } from "../components/EmptyState";
import { Field, Input, Select, Toggle } from "../components/Field";
import { Modal } from "../components/Modal";
import { toastApiError, useToast } from "../components/Toast";
import { useApi } from "../hooks/useApi";
import { CANCEL_LABEL, MODE_LABEL, QUALITY_LABEL, fmtDate } from "../labels";
import { useStudio } from "../state/studio";


function numOrUndef(s: string): number | undefined {
  const t = s.trim().replace(",", ".");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function ProviderForm({ provider, types, onClose, onSaved }: { provider: ProviderConfig | null; types: ProviderType[]; onClose: () => void; onSaved: (p: ProviderConfig) => void }) {
  const editing = Boolean(provider);
  const [type, setType] = useState(provider?.providerType ?? types[0]?.type ?? "mock");
  const meta = types.find((t) => t.type === type);
  const [name, setName] = useState(provider?.name ?? "");
  const [endpoint, setEndpoint] = useState(provider?.endpoint ?? meta?.defaultEndpoint ?? "");
  const [models, setModels] = useState((provider?.modelIds ?? meta?.defaultModels ?? []).join(", "));
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModelId ?? "");
  const [maxConc, setMaxConc] = useState(String(provider?.maxConcurrency ?? meta?.defaultConcurrency ?? 2));
  const [rpm, setRpm] = useState(String(provider?.requestsPerMinute ?? meta?.defaultRpm ?? 30));
  const [changeKey, setChangeKey] = useState(!provider?.hasApiKey);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [webhook, setWebhook] = useState(provider?.webhookEnabled ?? false);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  // Tuỳ chọn riêng của muse2api
  const [extraPrompt, setExtraPrompt] = useState(String(provider?.options.extraPrompt ?? ""));
  const [reqTimeout, setReqTimeout] = useState(provider?.options.requestTimeoutMs !== undefined ? String(provider.options.requestTimeoutMs) : "");
  const [videoTimeout, setVideoTimeout] = useState(provider?.options.videoTimeoutSec !== undefined ? String(provider.options.videoTimeoutSec) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const authNone = (meta?.authType ?? provider?.authType) === "none";
  const isMock = type === "mock";
  const isMuse = type === "muse2api";
  // Không nhập đơn giá trong giao diện nữa (người dùng yêu cầu bỏ): chi phí luôn "không xác định",
  // mỗi lần duyệt batch phải xác nhận chấp nhận. Đơn giá cũ trong options vẫn được GIỮ nguyên khi lưu.
  // muse2api không có webhook (app.py không gửi callback).
  const hasWebhook = !isMock && !isMuse;
  const modelList = useMemo(
    () =>
      models
        .split(/[,\n]/)
        .map((m) => m.trim())
        .filter(Boolean),
    [models],
  );

  const onType = (t: string) => {
    setType(t);
    const m = types.find((x) => x.type === t);
    if (m) {
      setEndpoint(m.defaultEndpoint);
      setModels(m.defaultModels.join(", "));
      setMaxConc(String(m.defaultConcurrency));
      setRpm(String(m.defaultRpm));
      setDefaultModel("");
      setChangeKey(true);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Giữ nguyên mọi option sẵn có (gồm đơn giá cũ nếu từng nhập qua API) - giao diện không sửa giá nữa
      const options = {
        ...(provider?.options ?? {}),
        ...(isMuse
          ? {
              extraPrompt: extraPrompt.trim() || undefined,
              requestTimeoutMs: numOrUndef(reqTimeout),
              videoTimeoutSec: numOrUndef(videoTimeout),
            }
          : {}),
      };
      const body: ProviderInput = {
        name: name.trim() || undefined,
        endpoint: endpoint.trim(),
        modelIds: modelList,
        defaultModelId: defaultModel && modelList.includes(defaultModel) ? defaultModel : (modelList[0] ?? null),
        maxConcurrency: Math.round(Number(maxConc)) || 1,
        requestsPerMinute: Math.round(Number(rpm)) || 1,
        options: JSON.parse(JSON.stringify(options)) as ProviderInput["options"],
        enableWebhook: webhook,
      };
      if (!authNone) {
        if (clearKey) body.apiKey = null;
        else if (changeKey && apiKey.trim()) body.apiKey = apiKey.trim();
      }
      const saved = editing ? await api.updateProvider(provider!.id, { ...body, enabled }) : await api.createProvider({ ...body, providerType: type });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title={editing ? `Sửa provider: ${provider!.name}` : "Thêm provider"}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Hủy
          </Button>
          <Button variant="primary" loading={busy} disabled={!modelList.length} onClick={() => void submit()}>
            {editing ? "Lưu thay đổi" : "Thêm provider"}
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Loại provider">
          <Select value={type} disabled={editing} onChange={(e) => onType(e.target.value)} options={types.map((t) => ({ value: t.type, label: t.label }))} />
        </Field>
        <Field label="Tên hiển thị">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={meta?.label} />
        </Field>
      </div>
      {isMock ? <MockBadge /> : null}
      {isMuse ? (
        <div className="banner banner-neutral">
          <strong>muse2api là một service RIÊNG</strong> bạn tự dựng (
          <a href="https://github.com/czg86389-hub/muse2api" target="_blank" rel="noreferrer">
            github.com/czg86389-hub/muse2api
          </a>
          ) — nó lái web muse.ai bằng Chromium. Ứng dụng này chỉ cần <em>địa chỉ</em> + <em>API key</em> của service đó.
          <br />
          Việc thêm tài khoản Muse và lấy cookie làm ở <strong>trang quản trị của muse2api</strong> (<code>/admin</code>), không làm ở đây. Mỗi video TIÊU HẠN MỨC tài khoản Muse, không tính tiền theo request.
        </div>
      ) : null}
      {!isMock ? (
        <Field label="Endpoint" hint={isMuse ? "Địa chỉ service muse2api, vd http://127.0.0.1:18610" : "Địa chỉ API của provider"}>
          <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="mono" />
        </Field>
      ) : null}
      <div className="grid-2">
        <Field label="Model id (phân cách bằng dấu phẩy)" hint="Model id lạ sẽ dùng giới hạn an toàn (chưa xác minh)">
          <Input value={models} onChange={(e) => setModels(e.target.value)} className="mono" />
        </Field>
        <Field label="Model mặc định">
          <Select value={defaultModel && modelList.includes(defaultModel) ? defaultModel : (modelList[0] ?? "")} onChange={(e) => setDefaultModel(e.target.value)} options={modelList.map((m) => ({ value: m, label: m }))} />
        </Field>
        <Field label="Số luồng tối đa (đồng thời)" hint="Đặt theo quota tài khoản của bạn ở provider (1-64)">
          <Input type="number" min={1} max={64} value={maxConc} onChange={(e) => setMaxConc(e.target.value)} />
        </Field>
        <Field label="Số yêu cầu/phút (RPM)">
          <Input type="number" min={1} max={10000} value={rpm} onChange={(e) => setRpm(e.target.value)} />
        </Field>
      </div>

      {!authNone ? (
        <div className="field">
          <span className="field-label">API key</span>
          {provider?.hasApiKey && !changeKey && !clearKey ? (
            <div className="key-row">
              <Badge tone="success">
                <KeyRound size={12} /> Đã lưu key
              </Badge>
              <span className="muted small">Key được mã hóa, không bao giờ hiển thị lại.</span>
              <span className="spacer" />
              <Button size="sm" onClick={() => setChangeKey(true)}>
                Đổi key
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setClearKey(true)}>
                Xóa key
              </Button>
            </div>
          ) : clearKey ? (
            <div className="key-row">
              <Badge tone="warning">Key sẽ bị xóa khi lưu</Badge>
              <Button size="sm" variant="ghost" onClick={() => setClearKey(false)}>
                Hoàn tác
              </Button>
            </div>
          ) : (
            <div className="key-row">
              <Input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider?.hasApiKey ? "Nhập key mới" : "Dán API key"} />
              {provider?.hasApiKey ? (
                <Button size="sm" variant="ghost" onClick={() => (setChangeKey(false), setApiKey(""))}>
                  Giữ key cũ
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {hasWebhook ? <Toggle checked={webhook} onChange={setWebhook} label="Nhận webhook từ provider" description="Chỉ là tín hiệu để kiểm tra lại sớm hơn; cần PUBLIC_BASE_URL trên máy chủ. Không bật vẫn chạy bình thường (poll định kỳ)." /> : null}
      {editing ? <Toggle checked={enabled} onChange={setEnabled} label="Đang bật" /> : null}

      {isMuse ? (
        <fieldset className="fieldset">
          <legend>Tuỳ chọn muse2api</legend>
          <p className="muted small">
            Mỗi video <strong>tiêu hạn mức tài khoản Muse</strong>, nên mỗi lần chạy bạn vẫn phải xác nhận. Hạn mức còn lại xem ở trang quản trị muse2api.
          </p>
          <Field label="Chỉ dẫn thêm vào mọi prompt (tuỳ chọn)" hint="Nối vào cuối mỗi prompt gửi sang Muse, vd: phong cách điện ảnh, ánh sáng mềm">
            <Input value={extraPrompt} onChange={(e) => setExtraPrompt(e.target.value)} placeholder="để trống nếu không cần" />
          </Field>
          <div className="grid-2">
            <Field label="Hạn chờ mỗi request (ms)" hint="Để trống = 60000. muse2api chạy browser thật nên có thể chậm.">
              <Input type="number" min={1000} value={reqTimeout} onChange={(e) => setReqTimeout(e.target.value)} placeholder="60000" />
            </Field>
            <Field label="Hạn tạo video phía muse2api (giây)" hint="Gửi kèm field timeout để muse2api tự bỏ job treo. Để trống = dùng mặc định của nó (600).">
              <Input type="number" min={30} value={videoTimeout} onChange={(e) => setVideoTimeout(e.target.value)} placeholder="600" />
            </Field>
          </div>
        </fieldset>
      ) : null}

      <ErrorBanner error={error} />
    </Modal>
  );
}

function ProviderCard({ p, onEdit, onChanged }: { p: ProviderConfig; onEdit: () => void; onChanged: () => void }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [busy, setBusy] = useState<string | null>(null);
  const caps = p.capabilities;

  const test = async () => {
    setBusy("test");
    try {
      const r = await api.testProvider(p.id);
      if (r.ok) toast.success("Kết nối được", r.message);
      else toast.error("Kết nối thất bại", r.message);
      onChanged();
    } catch (e) {
      toastApiError(toast, "Không kiểm tra được", e);
    } finally {
      setBusy(null);
    }
  };
  const disable = async () => {
    if (!(await dialogs.confirm({ title: `Vô hiệu hóa ${p.name}?`, body: "Provider bị tắt sẽ không nhận batch mới. Batch đang chạy có thể bị chặn gửi job mới.", confirmLabel: "Vô hiệu hóa", danger: true }))) return;
    setBusy("toggle");
    try {
      await api.disableProvider(p.id);
      toast.success("Đã vô hiệu hóa provider");
      onChanged();
    } catch (e) {
      toastApiError(toast, "Không vô hiệu hóa được", e);
    } finally {
      setBusy(null);
    }
  };
  const enable = async () => {
    setBusy("toggle");
    try {
      await api.updateProvider(p.id, { enabled: true });
      toast.success("Đã bật lại provider");
      onChanged();
    } catch (e) {
      toastApiError(toast, "Không bật được", e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`provider-card${p.enabled ? "" : " is-disabled"}`}>
      <div className="provider-head">
        <div>
          <div className="provider-name">
            <Plug size={16} aria-hidden /> {p.name}
          </div>
          <div className="muted small">
            {caps.label} · <code>{p.id}</code>
          </div>
        </div>
        <ProviderStatusBadge status={p.status} />
        {p.providerType === "mock" ? <MockBadge /> : null}
        <span className="spacer" />
        <div className="provider-actions">
          <Button size="sm" icon={<PlugZap size={14} />} loading={busy === "test"} onClick={() => void test()}>
            Kiểm tra kết nối
          </Button>
          <Button size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
            Sửa
          </Button>
          {p.enabled ? (
            <Button size="sm" variant="ghost" icon={<PowerOff size={14} />} loading={busy === "toggle"} onClick={() => void disable()}>
              Vô hiệu hóa
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={<Power size={14} />} loading={busy === "toggle"} onClick={() => void enable()}>
              Bật lại
            </Button>
          )}
        </div>
      </div>

      <div className="provider-facts">
        {p.endpoint ? (
          <div>
            <span className="muted">Endpoint</span> <code className="tiny">{p.endpoint}</code>
          </div>
        ) : null}
        <div>
          <span className="muted">API key</span> {p.authType === "none" ? "không cần" : p.hasApiKey ? <Badge tone="success">Đã lưu key</Badge> : <Badge tone="warning">Chưa có key</Badge>}
        </div>
        <div>
          <span className="muted">Đồng thời</span> <strong>{p.maxConcurrency}</strong> luồng · <strong>{p.requestsPerMinute}</strong> yêu cầu/phút
        </div>
        {p.providerType === "muse2api" ? (
          <div>
            <span className="muted">Hạn mức</span> tiêu hạn mức tài khoản Muse (xem ở trang quản trị muse2api)
          </div>
        ) : null}
        <div>
          <span className="muted">Hủy job</span> {CANCEL_LABEL[caps.cancel] ?? caps.cancel} · {caps.progress ? "báo % tiến độ" : "không báo %"} · {caps.idempotency ? "chống gửi trùng" : "không chống gửi trùng"}
          {caps.webhook ? ` · webhook ${p.webhookEnabled ? "đang bật" : "tắt"}` : ""}
        </div>
        <div>
          <span className="muted">Lần kiểm tra cuối</span>{" "}
          {p.lastTest ? (
            <span className={p.lastTest.ok ? "text-success" : "text-danger"}>
              {p.lastTest.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {p.lastTest.message} · {fmtDate(p.lastTest.at)}
            </span>
          ) : (
            "chưa kiểm tra"
          )}
        </div>
      </div>
      {caps.concurrencyHint || caps.docsUrl ? (
        <Banner tone="neutral">
          {caps.concurrencyHint}{" "}
          {caps.docsUrl ? (
            <a className="link" href={caps.docsUrl} target="_blank" rel="noreferrer">
              Tài liệu provider <ExternalLink size={11} />
            </a>
          ) : null}
        </Banner>
      ) : null}

      <div className="table-wrap">
        <table className="table model-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Chế độ</th>
              <th>Thời lượng</th>
              <th>Tỷ lệ</th>
              <th>Độ phân giải</th>
              <th>Âm thanh</th>
              <th>Khác</th>
            </tr>
          </thead>
          <tbody>
            {caps.models.map((m) => (
              <tr key={m.modelId}>
                <td data-label="Model">
                  <div className="strong">{m.label}</div>
                  <code className="tiny">{m.modelId}</code>
                  {m.modelId === p.defaultModelId ? <Badge tone="accent">mặc định</Badge> : null}
                  {!m.verified ? <Badge tone="warning">chưa xác minh</Badge> : null}
                </td>
                <td data-label="Chế độ" className="small">
                  {m.modes.map((x) => MODE_LABEL[x] ?? x).join(", ")}
                </td>
                <td data-label="Thời lượng" className="small">
                  {m.durations.min}-{m.durations.max}s{m.durations.auto ? " · tự chọn" : ""}
                </td>
                <td data-label="Tỷ lệ" className="small">
                  {m.aspectRatios.join(" ")}
                </td>
                <td data-label="Độ phân giải" className="small">
                  {m.resolutions.join(" ")}
                </td>
                <td data-label="Âm thanh">{m.audio ? <Badge tone="success">Có</Badge> : <Badge tone="muted">Không</Badge>}</td>
                <td data-label="Khác" className="small">
                  {m.negativePrompt ? "negative · " : ""}
                  {m.qualityModes.length ? `${m.qualityModes.map((q) => QUALITY_LABEL[q] ?? q).join("/")} · ` : ""}
                  ≤{m.maxPromptChars} ký tự · {m.maxReferenceImages} ảnh tham chiếu
                  {m.notes.length ? <div className="muted tiny">{m.notes.join(" ")}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

export function ProvidersPage() {
  const { providers, providersLoading, providersError, reloadProviders } = useStudio();
  const types = useApi(() => api.providerTypes().then((r) => r.types), []);
  const [form, setForm] = useState<{ provider: ProviderConfig | null } | null>(null);
  const toast = useToast();

  return (
    <div className="page-stack">
      <section className="card">
        <div className="card-head">
          <div className="card-title">
            <Plug size={16} aria-hidden /> Provider video
          </div>
          <div className="card-head-actions">
            <Button variant="primary" icon={<Plus size={15} />} disabled={!types.data?.length} onClick={() => setForm({ provider: null })}>
              Thêm provider
            </Button>
          </div>
        </div>
        <p className="muted small">Provider là nơi thật sự tạo video (Seedance trên BytePlus ModelArk, hoặc Muse qua service muse2api bạn tự dựng). Thông số model hiển thị đúng như adapter khai báo; giao diện Batch Studio chỉ cho chọn những gì model hỗ trợ.</p>
        {types.error ? <ErrorBanner error={types.error} onRetry={types.reload} /> : null}
        {providersError ? <ErrorBanner error={providersError} onRetry={reloadProviders} /> : null}
        {providersLoading ? <div className="skeleton" style={{ height: 200 }} /> : null}
        {!providersLoading && !providers.length ? <EmptyState icon={<Plug size={22} />} title="Chưa có provider" description="Thêm Seedance (cần API key BytePlus) hoặc Mock (miễn phí, tạo video kiểm thử)." /> : null}
        <div className="provider-list">
          {providers.map((p) => (
            <ProviderCard key={p.id} p={p} onEdit={() => setForm({ provider: p })} onChanged={() => void reloadProviders()} />
          ))}
        </div>
      </section>
      {form && types.data ? (
        <ProviderForm
          provider={form.provider}
          types={types.data}
          onClose={() => setForm(null)}
          onSaved={(p) => {
            toast.success(form.provider ? "Đã lưu provider" : `Đã thêm provider “${p.name}”`);
            void reloadProviders();
          }}
        />
      ) : null}
    </div>
  );
}
