import { useEffect, useState } from "react";
import { Plus, Share2 } from "lucide-react";
import { api, asApiError, type ApiError, type FbPage, type FbReelItem, type FbSettings } from "../api";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { useDialogs } from "../components/ConfirmDialog";
import { Banner, EmptyState, ErrorBanner, Loading } from "../components/EmptyState";
import { Field, Input, Select, TextArea, Toggle } from "../components/Field";
import { toastApiError, useToast } from "../components/Toast";
import { useApi, usePoll } from "../hooks/useApi";
import { FB_REEL_STATUS_META, fmtDate, fmtSeconds, truncate } from "../labels";

/** Cài đặt CHUNG: áp dụng cho mọi Page (mẫu caption, AI caption, phiên bản Graph) */
function SharedSettingsCard({ settings, onSaved }: { settings: FbSettings; onSaved: (s: FbSettings) => void }) {
  const toast = useToast();
  const [f, setF] = useState<FbSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => setF(settings), [settings]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveFbSettings({ graphVersion: f.graphVersion.trim(), captionTemplate: f.captionTemplate, aiCaption: f.aiCaption });
      onSaved(r);
      toast.success("Đã lưu cài đặt chung");
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">Cài đặt chung (áp dụng cho mọi Page)</div>
      </div>
      <div className="form-grid">
        <Field label="Phiên bản Graph API" hint="Vd v26.0">
          <Input className="mono" value={f.graphVersion} onChange={(e) => setF({ ...f, graphVersion: e.target.value })} />
        </Field>
        <Field label="Mẫu caption" hint="Biến: {prompt} (prompt video), {tieu_de} (tiêu đề video). Hashtag riêng của từng Page được nối vào cuối.">
          <TextArea rows={3} value={f.captionTemplate} onChange={(e) => setF({ ...f, captionTemplate: e.target.value })} placeholder="{prompt}" />
        </Field>
        <Toggle checked={f.aiCaption} onChange={(v) => setF({ ...f, aiCaption: v })} label="Dùng AI viết caption" description="Dùng LLM trong Cài đặt để viết caption từ prompt; lỗi thì dùng mẫu ở trên." />
        <ErrorBanner error={error} />
        <div className="row-end">
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Lưu cài đặt chung
          </Button>
        </div>
      </div>
    </section>
  );
}

interface PageForm {
  name: string;
  pageId: string;
  token: string;
  intervalMin: number;
  autoEnabled: boolean;
  requireApproval: boolean;
  hashtags: string;
}

const emptyForm: PageForm = { name: "", pageId: "", token: "", intervalMin: 60, autoEnabled: false, requireApproval: true, hashtags: "" };

/** Form thêm / sửa MỘT Page */
function PageEditor({ page, onDone, onCancel }: { page: FbPage | null; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [f, setF] = useState<PageForm>(page ? { name: page.name, pageId: page.pageId, token: "", intervalMin: page.intervalMin, autoEnabled: page.autoEnabled, requireApproval: page.requireApproval, hashtags: page.hashtags } : emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = <K extends keyof PageForm>(k: K, v: PageForm[K]) => setF({ ...f, [k]: v });

  const toggleNoApproval = async (v: boolean) => {
    if (v) {
      const ok = await dialogs.confirm({
        title: "Tự đăng không cần duyệt?",
        body: "Video sẽ được đăng công khai lên Page này mà không hỏi lại. Việc đăng không thể hoàn tác từ Batch Video Studio.",
        confirmLabel: "Bật, không cần duyệt",
        danger: true,
      });
      if (!ok) return;
    }
    set("requireApproval", !v);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: f.name.trim() || undefined, pageId: f.pageId.trim(), intervalMin: Number(f.intervalMin), autoEnabled: f.autoEnabled, requireApproval: f.requireApproval, hashtags: f.hashtags, ...(f.token.trim() ? { pageToken: f.token.trim() } : {}) };
      if (page) await api.saveFbPage(page.id, body);
      else await api.createFbPage(body);
      toast.success(page ? "Đã lưu Page" : "Đã thêm Page");
      onDone();
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-title">{page ? `Sửa Page “${page.name}”` : "Thêm Page Facebook"}</div>
      <div className="form-grid">
        <div className="grid-3">
          <Field label="Tên hiển thị" hint="Để trống = tự lấy từ Facebook khi bấm Kiểm tra kết nối">
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="vd: Shop Mỹ phẩm" />
          </Field>
          <Field label="Page ID" hint="Dãy số, lấy ở phần Giới thiệu của Page">
            <Input className="mono" value={f.pageId} onChange={(e) => set("pageId", e.target.value)} placeholder="vd: 1234567890" />
          </Field>
          <Field label="Page access token" hint={page ? "Để trống = giữ token cũ. Không bao giờ hiển thị lại." : "Bắt buộc. Quyền đăng bài lên Page."}>
            <Input type="password" autoComplete="new-password" value={f.token} onChange={(e) => set("token", e.target.value)} placeholder={page?.tokenConfigured ? `Đã cấu hình …${page.tokenLast4 ?? ""}` : "Dán Page access token"} />
          </Field>
        </div>
        <Field label="Khoảng cách đăng (phút)" hint="Đăng đều 1 video mỗi khoảng này trên Page này (5–1440). Mặc định 60.">
          <Input type="number" min={5} max={1440} value={f.intervalMin} onChange={(e) => set("intervalMin", Number(e.target.value))} />
        </Field>
        <Toggle checked={f.autoEnabled} onChange={(v) => set("autoEnabled", v)} label="Bật tự động đăng" description="Tắt = batch chọn Page này vẫn tạo được nhưng video không vào hàng đợi. Chỉ video làm xong SAU khi bật mới vào hàng." />
        <Toggle
          checked={!f.requireApproval}
          onChange={(v) => void toggleNoApproval(v)}
          label="Tự đăng không cần duyệt"
          description={f.requireApproval ? "Đang TẮT: mỗi video ở trạng thái Chờ duyệt, bạn bấm Duyệt mới vào hàng đăng." : "Đang BẬT: video sẽ được đăng công khai mà không hỏi lại."}
        />
        <Field label="Hashtag mặc định của Page" hint="Cách nhau bằng dấu cách, vd: #review #xuhuong">
          <Input value={f.hashtags} onChange={(e) => set("hashtags", e.target.value)} placeholder="#review #xuhuong" />
        </Field>
        <ErrorBanner error={error} />
        <div className="row-end">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {page ? "Lưu Page" : "Thêm Page"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PagesCard({ pages, loading, error, reload, onChanged }: { pages: FbPage[]; loading: boolean; error: ApiError | null; reload: () => void; onChanged: () => void }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [editing, setEditing] = useState<FbPage | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const changed = () => {
    setEditing(null);
    reload();
    onChanged();
  };

  const test = async (p: FbPage) => {
    setBusyId(p.id);
    try {
      const r = await api.testFbPage(p.id);
      if (r.ok) toast.success(r.message);
      else toast.error("Kết nối thất bại", r.message);
      reload();
    } catch (e) {
      toastApiError(toast, "Không kiểm tra được kết nối", e);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (p: FbPage) => {
    const ok = await dialogs.confirm({
      title: `Xóa Page “${p.name}”?`,
      body: "Token của Page bị xóa ngay. Các video đang chờ duyệt / đã duyệt của Page này sẽ bị HỦY (không chuyển sang Page khác). Lịch sử đã đăng giữ nguyên. Không xóa được khi Page đang đăng một video.",
      confirmLabel: "Xóa Page",
      danger: true,
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      const r = await api.deleteFbPage(p.id);
      toast.success("Đã xóa Page", r.cancelled ? `Đã hủy ${r.cancelled} video đang chờ.` : undefined);
      changed();
    } catch (e) {
      toastApiError(toast, "Không xóa được Page", e);
    } finally {
      setBusyId(null);
    }
  };

  const toggleAuto = async (p: FbPage, v: boolean) => {
    setBusyId(p.id);
    try {
      await api.saveFbPage(p.id, { autoEnabled: v });
      changed();
    } catch (e) {
      toastApiError(toast, "Không đổi được công tắc", e);
    } finally {
      setBusyId(null);
    }
  };

  const resume = async (p: FbPage) => {
    try {
      await api.resumeFbPage(p.id);
      toast.success(`Đã tiếp tục hàng đợi của “${p.name}”`);
      changed();
    } catch (e) {
      toastApiError(toast, "Không tiếp tục được", e);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <Share2 size={16} aria-hidden /> Danh sách Page Facebook
        </div>
        <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
          Thêm Page
        </Button>
      </div>
      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}
      {loading ? <Loading /> : null}
      {!loading && !pages.length ? (
        <Banner tone="info" title="Chưa có Page nào">
          Thêm Page (Page ID + Page access token có quyền đăng bài) để tự đăng Reels. Khi đã có Page, mỗi batch bạn tạo phải chọn Page đích (hoặc “Không đăng lên Facebook”).
        </Banner>
      ) : null}
      <div style={{ display: "grid", gap: 10 }}>
        {pages.map((p) => (
          <div key={p.id} className="card" style={{ padding: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong>{p.name}</strong>
              <span className="muted small mono">ID {p.pageId}</span>
              <Badge tone="success">Token …{p.tokenLast4}</Badge>
              <Badge tone={p.requireApproval ? "neutral" : "warning"}>{p.requireApproval ? "Cần duyệt" : "Không cần duyệt"}</Badge>
              <span className="muted small">
                Cách {p.intervalMin} phút{p.hashtags ? ` · ${truncate(p.hashtags, 40)}` : ""}
              </span>
              <span className="spacer" />
              <Toggle checked={p.autoEnabled} disabled={busyId === p.id} onChange={(v) => void toggleAuto(p, v)} label="Tự đăng" />
              <Button size="sm" loading={busyId === p.id} onClick={() => void test(p)}>
                Kiểm tra kết nối
              </Button>
              <Button size="sm" onClick={() => setEditing(p)}>
                Sửa
              </Button>
              <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void remove(p)}>
                Xóa
              </Button>
            </div>
            {p.pause ? (
              <Banner
                tone="danger"
                title={p.pause.kind === "token" ? "Page đã tạm dừng: token hết hạn hoặc bị thu hồi" : "Page đã tạm dừng: token thiếu quyền đăng lên Page"}
                actions={
                  <Button size="sm" variant="primary" onClick={() => void resume(p)}>
                    Tiếp tục
                  </Button>
                }
              >
                <div>{p.pause.message}</div>
                <div className="muted small">Bấm Sửa, cập nhật Page access token, lưu, rồi bấm Tiếp tục. Từ {fmtDate(p.pause.at)}. Các Page khác vẫn chạy bình thường.</div>
              </Banner>
            ) : null}
          </div>
        ))}
      </div>
      {editing ? <PageEditor key={editing === "new" ? "new" : editing.id} page={editing === "new" ? null : editing} onDone={changed} onCancel={() => setEditing(null)} /> : null}
    </section>
  );
}

function QueueCard({ refreshKey, pages }: { refreshKey: number; pages: FbPage[] }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [pageFilter, setPageFilter] = useState("");
  const q = useApi(() => api.fbReelsQueue({ pageId: pageFilter || undefined }), [refreshKey, pageFilter]);
  const [busyId, setBusyId] = useState<string | null>(null);
  usePoll(q.reload, 15000, true);

  const act = async (it: FbReelItem, fn: () => Promise<unknown>, ok: string) => {
    setBusyId(it.id);
    try {
      await fn();
      toast.success(ok);
      q.reload();
    } catch (e) {
      toastApiError(toast, "Thao tác không thành công", e);
      q.reload();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (it: FbReelItem) => {
    const ok = await dialogs.confirm({ title: "Xóa khỏi hàng đăng?", body: "Chỉ xóa khỏi hàng đăng Facebook, KHÔNG xóa video khỏi Thư viện hay ổ đĩa.", confirmLabel: "Xóa khỏi hàng", danger: true });
    if (ok) await act(it, () => api.fbReelsRemove(it.id), "Đã xóa khỏi hàng");
  };

  const approve = async (it: FbReelItem) => {
    const ok = await dialogs.confirm({ title: "Duyệt video này?", body: `Video sẽ vào hàng đăng và được đăng công khai lên Page “${it.pageName ?? "?"}” khi đến lượt (nếu Page đang bật tự động đăng).`, confirmLabel: "Duyệt" });
    if (ok) await act(it, () => api.fbReelsApprove(it.id), "Đã duyệt");
  };

  const items = q.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">Hàng đợi đăng Reels</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Select value={pageFilter} onChange={(e) => setPageFilter(e.target.value)} options={[{ value: "", label: "Mọi Page" }, ...pages.map((p) => ({ value: p.id, label: p.name }))]} aria-label="Lọc theo Page" />
          <Button size="sm" onClick={q.reload}>
            Làm mới
          </Button>
        </div>
      </div>
      {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : null}
      {q.loading && !q.data ? <Loading /> : null}
      {q.data && !items.length ? <EmptyState compact title="Chưa có video trong hàng đăng" description="Video làm xong của batch đã chọn Page (và Page đang bật tự đăng) sẽ xuất hiện ở đây." /> : null}
      {items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Video</th>
                <th>Page</th>
                <th>Thời lượng</th>
                <th>Trạng thái</th>
                <th>Ghi chú</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const m = FB_REEL_STATUS_META[it.status] ?? { label: it.statusLabel, tone: "neutral" as const };
                const note = it.skipReason ?? it.errorMessage ?? (it.publishedAt ? `Đăng lúc ${fmtDate(it.publishedAt)}` : "");
                const busy = busyId === it.id;
                return (
                  <tr key={it.id}>
                    <td>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {it.thumbnailUrl ? <img src={it.thumbnailUrl} alt="" width={36} height={64} style={{ objectFit: "cover", borderRadius: 4 }} /> : null}
                        <div>
                          <div>{truncate(it.title, 60)}</div>
                          <div className="muted small">{truncate(it.prompt, 80)}</div>
                        </div>
                      </div>
                    </td>
                    <td className="small">{it.pageName ?? "—"}</td>
                    <td>{fmtSeconds(it.durationSec)}</td>
                    <td>
                      <Badge tone={m.tone}>{m.label}</Badge>
                    </td>
                    <td className="small">{truncate(note, 160)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {it.status === "pending_review" ? (
                          <>
                            <Button size="sm" variant="success" disabled={busy} onClick={() => void approve(it)}>
                              Duyệt
                            </Button>
                            <Button size="sm" disabled={busy} onClick={() => void act(it, () => api.fbReelsReject(it.id), "Đã từ chối")}>
                              Từ chối
                            </Button>
                          </>
                        ) : null}
                        {["failed", "skipped", "rejected"].includes(it.status) ? (
                          <Button size="sm" disabled={busy} onClick={() => void act(it, () => api.fbReelsRetry(it.id), "Đã đưa lại vào hàng đăng")}>
                            Đăng lại
                          </Button>
                        ) : null}
                        {it.status !== "publishing" ? (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(it)}>
                            Xóa khỏi hàng
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function FacebookPage() {
  const [key, setKey] = useState(0);
  const d = useApi(() => api.fbPages(), []);
  const pages = d.data?.pages ?? [];
  return (
    <div className="page-stack">
      <QueueCard refreshKey={key} pages={pages} />
      <PagesCard pages={pages} loading={d.loading} error={d.error} reload={() => void d.reload()} onChanged={() => setKey((k) => k + 1)} />
      {d.data ? <SharedSettingsCard settings={d.data.settings} onSaved={(s) => d.setData((prev) => (prev ? { ...prev, settings: s } : prev))} /> : null}
    </div>
  );
}
