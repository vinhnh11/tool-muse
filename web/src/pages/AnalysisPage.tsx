import { useMemo, useRef, useState, type DragEvent } from "react";
import { CheckCircle2, Film, Loader2, RefreshCw, ScanSearch, Sparkles, UploadCloud, Volume2, VolumeX, XCircle } from "lucide-react";
import { api, asApiError, uploadAssets, type ApiError, type Asset } from "../api";
import { AnalysisStatusBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { EmptyState, ErrorBanner } from "../components/EmptyState";
import { Checkbox } from "../components/Field";
import { ProgressBar } from "../components/ProgressBar";
import { useToast } from "../components/Toast";
import { useApi, useLocalStorage } from "../hooks/useApi";
import { useRealtimeRefetch } from "../hooks/useEvents";
import { fmtBytes, fmtRelative, fmtSeconds } from "../labels";
import { useStudio } from "../state/studio";
import { AnalysisDetail } from "./AnalysisDetail";

interface UploadItem {
  key: string;
  name: string;
  size: number;
  pct: number;
  state: "uploading" | "done" | "error";
  error?: string;
}

function UploadZone({ onUploaded }: { onUploaded: (assets: Asset[]) => void }) {
  const { sessionId } = useStudio();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const start = async (files: File[]) => {
    const vids = files.filter((f) => /\.(mp4|mov|webm|mkv)$/i.test(f.name) || f.type.startsWith("video/"));
    if (!vids.length) return;
    const batch = vids.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, size: f.size, pct: 0, state: "uploading" as const }));
    setItems((xs) => [...batch, ...xs.filter((x) => x.state === "uploading")]);
    const done: Asset[] = [];
    for (let i = 0; i < vids.length; i++) {
      const key = batch[i]!.key;
      try {
        const out = await uploadAssets([vids[i]!], { kind: "reference", sessionId }, (pct) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, pct } : x))));
        done.push(...out);
        setItems((xs) => xs.map((x) => (x.key === key ? { ...x, pct: 100, state: "done" } : x)));
      } catch (e) {
        setItems((xs) => xs.map((x) => (x.key === key ? { ...x, state: "error", error: asApiError(e).message } : x)));
      }
    }
    if (done.length) onUploaded(done);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void start(Array.from(e.dataTransfer.files ?? []));
  };

  return (
    <div className="upload">
      <div
        className={`dropzone${drag ? " is-drag" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") input.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <UploadCloud size={28} aria-hidden />
        <div className="dropzone-title">Kéo thả video tham khảo vào đây hoặc bấm để chọn</div>
        <div className="muted small">MP4, MOV, WEBM, MKV · chọn được nhiều file · tối đa 4GB/file</div>
      </div>
      <input
        ref={input}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
        multiple
        hidden
        onChange={(e) => {
          void start(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {items.length ? (
        <ul className="upload-list">
          {items.map((u) => (
            <li key={u.key} className={`upload-item is-${u.state}`}>
              {u.state === "uploading" ? <Loader2 size={14} className="spin" /> : u.state === "done" ? <CheckCircle2 size={14} className="text-success" /> : <XCircle size={14} className="text-danger" />}
              <span className="upload-name">{u.name}</span>
              <span className="muted tiny">{fmtBytes(u.size)}</span>
              {u.state === "uploading" ? (
                <div className="upload-bar">
                  <ProgressBar value={u.pct} size="sm" />
                  <span className="tiny mono">{u.pct}%</span>
                </div>
              ) : null}
              {u.error ? <span className="text-danger small">{u.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AnalysisPage() {
  const { sessionId, session, navigate } = useStudio();
  const toast = useToast();
  const assets = useApi(() => api.assets({ kind: "reference", sessionId }).then((r) => r.assets), [sessionId]);
  const analyses = useApi(() => api.analyses({ sessionId }).then((r) => r.analyses), [sessionId]);
  useRealtimeRefetch((ev) => ev.type.startsWith("analysis."), () => void analyses.reload(), 400);
  const [picked, setPicked] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [selectedId, setSelectedId] = useLocalStorage<string | null>("bvs.analysis.selected", null);

  const latestByAsset = useMemo(() => {
    const m = new Map<string, NonNullable<typeof analyses.data>[number]>();
    for (const a of analyses.data ?? []) if (!m.has(a.assetId)) m.set(a.assetId, a);
    return m;
  }, [analyses.data]);
  const assetById = useMemo(() => new Map((assets.data ?? []).map((a) => [a.id, a])), [assets.data]);
  const selected = (analyses.data ?? []).find((a) => a.id === selectedId) ?? (analyses.data ?? [])[0] ?? null;

  const analyze = async () => {
    if (!picked.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestAnalyses({ assetIds: picked, sessionId, force });
      toast.success(`Đã xếp hàng phân tích ${r.analyses.length} video`, "Phân tích chạy nền - trang tự cập nhật tiến độ.");
      setPicked([]);
      if (r.analyses[0]) setSelectedId(r.analyses[0].id);
      await analyses.reload();
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const openPromptGenerator = () => {
    try {
      localStorage.setItem("bvs.batch.tab", JSON.stringify("ai"));
    } catch {
      /* bỏ qua */
    }
    navigate("batch");
  };

  return (
    <div className="page-stack">
      <section className="card">
        <div className="card-head">
          <div className="card-title">
            <UploadCloud size={16} aria-hidden /> Video tham khảo {session ? <span className="muted small">· phiên “{session.title}”</span> : <span className="muted small">· mọi phiên</span>}
          </div>
          <div className="card-head-actions">
            <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void assets.reload()} aria-label="Tải lại" title="Tải lại" />
          </div>
        </div>
        <UploadZone
          onUploaded={(list) => {
            toast.success(`Đã tải lên ${list.length} video`);
            setPicked((xs) => [...new Set([...xs, ...list.map((a) => a.id)])]);
            void assets.reload();
          }}
        />
        {assets.error ? <ErrorBanner error={assets.error} onRetry={assets.reload} /> : null}
        {assets.loading ? <div className="skeleton" style={{ height: 120 }} /> : null}
        {assets.data && !assets.data.length ? <EmptyState compact icon={<Film size={22} />} title="Chưa có video tham khảo" description="Tải lên video quảng cáo/viral bạn muốn học phong cách - hệ thống xem từng khung hình thật, không đoán từ tên file." /> : null}
        {assets.data?.length ? (
          <>
            <div className="toolbar">
              <Checkbox checked={picked.length === assets.data.length} indeterminate={picked.length > 0 && picked.length < assets.data.length} onChange={(on) => setPicked(on ? assets.data!.map((a) => a.id) : [])} label={`${picked.length}/${assets.data.length} đã chọn`} />
              <span className="spacer" />
              <Checkbox checked={force} onChange={setForce} label="Phân tích lại (bỏ qua kết quả cũ)" />
              <Button variant="primary" icon={<ScanSearch size={15} />} loading={busy} disabled={!picked.length} onClick={() => void analyze()}>
                Phân tích {picked.length ? `(${picked.length})` : ""}
              </Button>
            </div>
            <ErrorBanner error={error} title="Không bắt đầu phân tích được" />
            <div className="asset-grid">
              {assets.data.map((a) => {
                const an = latestByAsset.get(a.id);
                const on = picked.includes(a.id);
                return (
                  <article key={a.id} className={`asset-card${on ? " is-selected" : ""}`}>
                    <button type="button" className="asset-thumb" onClick={() => setPicked((xs) => (on ? xs.filter((x) => x !== a.id) : [...xs, a.id]))} aria-pressed={on} title={a.fileName}>
                      <img src={a.urls.thumbnail} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                      <span className="asset-duration mono">{fmtSeconds(a.durationSec)}</span>
                    </button>
                    <div className="asset-body">
                      <div className="asset-row">
                        <Checkbox ariaLabel={`Chọn ${a.fileName}`} checked={on} onChange={(v) => setPicked((xs) => (v ? [...xs, a.id] : xs.filter((x) => x !== a.id)))} />
                        <span className="asset-name" title={a.fileName}>
                          {a.fileName}
                        </span>
                      </div>
                      <div className="muted tiny asset-meta">
                        {a.width && a.height ? `${a.width}×${a.height}` : ""} · {fmtBytes(a.sizeBytes)} · {a.hasAudio ? <Volume2 size={11} aria-label="Có tiếng" /> : <VolumeX size={11} aria-label="Không tiếng" />}
                      </div>
                      {an ? (
                        <button type="button" className="asset-analysis" onClick={() => setSelectedId(an.id)}>
                          <AnalysisStatusBadge status={an.status} />
                          {an.status === "running" ? <span className="tiny mono">{an.progress}%</span> : null}
                        </button>
                      ) : (
                        <span className="muted tiny">Chưa phân tích</span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        ) : null}
      </section>

      <div className="analysis-layout">
        <section className="card analysis-list-card">
          <div className="card-head">
            <div className="card-title">
              <ScanSearch size={16} aria-hidden /> Bản phân tích
            </div>
          </div>
          {analyses.error ? <ErrorBanner error={analyses.error} onRetry={analyses.reload} /> : null}
          {analyses.loading ? <div className="skeleton" style={{ height: 120 }} /> : null}
          {analyses.data && !analyses.data.length ? <EmptyState compact title="Chưa có bản phân tích" description="Chọn video ở trên rồi bấm “Phân tích”." /> : null}
          <ul className="analysis-list">
            {(analyses.data ?? []).map((a) => (
              <li key={a.id}>
                <button type="button" className={`analysis-item${selected?.id === a.id ? " is-active" : ""}`} onClick={() => setSelectedId(a.id)}>
                  <div className="analysis-item-top">
                    <span className="asset-name">{assetById.get(a.assetId)?.fileName ?? a.assetId}</span>
                    <AnalysisStatusBadge status={a.status} />
                  </div>
                  {a.status === "running" || a.status === "queued" ? <ProgressBar value={a.status === "queued" ? null : a.progress} size="sm" /> : null}
                  <div className="muted tiny">
                    {a.status === "running" ? (a.step ?? "") : a.status === "failed" ? <span className="text-danger">{a.error}</span> : fmtRelative(a.updatedAt)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="card analysis-detail-card">
          {selected ? (
            <AnalysisDetail
              a={selected}
              asset={assetById.get(selected.assetId)}
              actions={
                selected.status === "completed" ? (
                  <Button size="sm" variant="primary" icon={<Sparkles size={14} />} onClick={openPromptGenerator}>
                    Dùng để tạo prompt
                  </Button>
                ) : null
              }
            />
          ) : (
            <EmptyState icon={<ScanSearch size={22} />} title="Chọn một bản phân tích để xem" description="Kết quả gồm diễn biến, hook, phong cách hình ảnh, chuyển động máy, nhịp dựng, âm thanh và gợi ý prompt - kèm độ phủ phân tích trung thực." />
          )}
        </section>
      </div>
    </div>
  );
}
