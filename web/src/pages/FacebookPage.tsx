import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import { api, asApiError, type ApiError, type FbReelItem, type FbReelsConfig } from "../api";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { useDialogs } from "../components/ConfirmDialog";
import { Banner, EmptyState, ErrorBanner, Loading } from "../components/EmptyState";
import { Field, Input, TextArea, Toggle } from "../components/Field";
import { toastApiError, useToast } from "../components/Toast";
import { useApi, usePoll } from "../hooks/useApi";
import { FB_REEL_STATUS_META, fmtDate, fmtSeconds, truncate } from "../labels";

function ConfigCard({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const s = useApi(() => api.fbReelsConfig(), []);
  const [f, setF] = useState<FbReelsConfig | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (s.data) setF(s.data);
  }, [s.data]);

  if (s.error) return <ErrorBanner error={s.error} onRetry={s.reload} />;
  if (!f) return <Loading />;
  const set = <K extends keyof FbReelsConfig>(k: K, v: FbReelsConfig[K]) => setF({ ...f, [k]: v });

  const save = async (patch: Partial<FbReelsConfig> = {}, clearToken = false) => {
    setBusy(true);
    setError(null);
    const n = { ...f, ...patch };
    try {
      const r = await api.saveFbReelsConfig({
        pageId: n.pageId.trim(),
        graphVersion: n.graphVersion.trim(),
        intervalMin: Number(n.intervalMin),
        autoEnabled: n.autoEnabled,
        requireApproval: n.requireApproval,
        captionTemplate: n.captionTemplate,
        hashtags: n.hashtags,
        aiCaption: n.aiCaption,
        ...(clearToken ? { pageToken: null } : token.trim() ? { pageToken: token.trim() } : {}),
      });
      s.setData(r);
      setF(r);
      setToken("");
      toast.success("Đã lưu cấu hình Facebook");
      onSaved();
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleNoApproval = async (v: boolean) => {
    if (v) {
      const ok = await dialogs.confirm({
        title: "Tự đăng không cần duyệt?",
        body: "Video sẽ được đăng công khai lên Page mà không hỏi lại. Việc đăng không thể hoàn tác từ Batch Video Studio.",
        confirmLabel: "Bật, không cần duyệt",
        danger: true,
      });
      if (!ok) return;
    }
    set("requireApproval", !v);
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.testFbReels();
      if (r.ok) toast.success(r.message);
      else toast.error("Kết nối thất bại", r.message);
    } catch (e) {
      toastApiError(toast, "Không kiểm tra được kết nối", e);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <Share2 size={16} aria-hidden /> Cấu hình đăng Reels lên Facebook Page
        </div>
        {f.tokenConfigured ? <Badge tone="success">Đã cấu hình …{f.tokenLast4}</Badge> : <Badge tone="warning">Chưa có token</Badge>}
      </div>
      {!f.tokenConfigured ? (
        <Banner tone="warning" title="Chưa cấu hình token">
          Nhập Page ID và Page access token (quyền đăng bài lên Page) rồi bấm Lưu. Chỉ đăng lên Page bạn quản trị, qua Graph API chính thức.
        </Banner>
      ) : null}
      <div className="form-grid">
        <div className="grid-3">
          <Field label="Page ID" hint="Dãy số, lấy ở phần Giới thiệu của Page">
            <Input className="mono" value={f.pageId} onChange={(e) => set("pageId", e.target.value)} placeholder="vd: 1234567890" />
          </Field>
          <Field label="Page access token" hint="Để trống = giữ token cũ. Không bao giờ hiển thị lại.">
            <Input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={f.tokenConfigured ? `Đã cấu hình …${f.tokenLast4 ?? ""}` : "Dán Page access token"} />
          </Field>
          <Field label="Phiên bản Graph API" hint="Vd v26.0">
            <Input className="mono" value={f.graphVersion} onChange={(e) => set("graphVersion", e.target.value)} />
          </Field>
        </div>
        <Field label="Khoảng cách đăng (phút)" hint="Đăng đều 1 video mỗi khoảng này (5–1440). Mặc định 60. Facebook giới hạn số Reels đăng qua API mỗi ngày.">
          <Input type="number" min={5} max={1440} value={f.intervalMin} onChange={(e) => set("intervalMin", Number(e.target.value))} />
        </Field>
        <Toggle checked={f.autoEnabled} onChange={(v) => set("autoEnabled", v)} label="Bật tự động đăng" description="Tắt = chỉ xếp hàng, không đăng. Chỉ video làm xong SAU khi bật mới vào hàng." />
        <Toggle
          checked={!f.requireApproval}
          onChange={(v) => void toggleNoApproval(v)}
          label="Tự đăng không cần duyệt"
          description={f.requireApproval ? "Đang TẮT: mỗi video ở trạng thái Chờ duyệt, bạn bấm Duyệt mới vào hàng đăng." : "Đang BẬT: video sẽ được đăng công khai mà không hỏi lại."}
        />
        <Field label="Mẫu caption" hint="Biến: {prompt} (prompt video), {tieu_de} (tiêu đề video)">
          <TextArea rows={3} value={f.captionTemplate} onChange={(e) => set("captionTemplate", e.target.value)} placeholder="{prompt}" />
        </Field>
        <Field label="Hashtag mặc định" hint="Cách nhau bằng dấu cách, vd: #review #xuhuong">
          <Input value={f.hashtags} onChange={(e) => set("hashtags", e.target.value)} placeholder="#review #xuhuong" />
        </Field>
        <Toggle checked={f.aiCaption} onChange={(v) => set("aiCaption", v)} label="Dùng AI viết caption" description="Dùng LLM trong Cài đặt để viết caption từ prompt; lỗi thì dùng mẫu ở trên." />
        <ErrorBanner error={error} />
        <div className="row-end">
          {f.updatedAt ? <span className="muted small">Cập nhật {fmtDate(f.updatedAt)}</span> : null}
          {f.tokenConfigured ? (
            <Button variant="ghost" loading={busy} onClick={() => void save({}, true)}>
              Xóa token
            </Button>
          ) : null}
          <Button loading={testing} disabled={!f.tokenConfigured} onClick={() => void test()}>
            Kiểm tra kết nối
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Lưu cấu hình
          </Button>
        </div>
      </div>
    </section>
  );
}

function QueueCard({ refreshKey }: { refreshKey: number }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const q = useApi(() => api.fbReelsQueue(), [refreshKey]);
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
    const ok = await dialogs.confirm({ title: "Duyệt video này?", body: "Video sẽ vào hàng đăng và được đăng công khai lên Page khi đến lượt (nếu đang bật tự động đăng).", confirmLabel: "Duyệt" });
    if (ok) await act(it, () => api.fbReelsApprove(it.id), "Đã duyệt");
  };

  const items = q.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">Hàng đợi đăng Reels</div>
        <Button size="sm" onClick={q.reload}>
          Làm mới
        </Button>
      </div>
      {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : null}
      {q.loading && !q.data ? <Loading /> : null}
      {q.data && !items.length ? <EmptyState compact title="Chưa có video trong hàng đăng" description="Video làm xong (sau khi lưu token) sẽ xuất hiện ở đây." /> : null}
      {items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Video</th>
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
  return (
    <div className="page-stack">
      <QueueCard refreshKey={key} />
      <ConfigCard onSaved={() => setKey((k) => k + 1)} />
    </div>
  );
}
