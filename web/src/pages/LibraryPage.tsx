import { useMemo, useState } from "react";
import { BookmarkCheck, BookmarkMinus, BookmarkPlus, Download, FileArchive, Film, Library, RefreshCw, Trash2, X } from "lucide-react";
import { api, exportUrls, type LibraryItem } from "../api";
import { VersionBadge } from "../components/Badge";
import { Button, IconButton, LinkButton } from "../components/Button";
import { EmptyState, ErrorBanner } from "../components/EmptyState";
import { Checkbox, Toggle } from "../components/Field";
import { Modal } from "../components/Modal";
import { Segmented } from "../components/Tabs";
import { VideoPlayer } from "../components/VideoPlayer";
import { useApi, useLocalStorage } from "../hooks/useApi";
import { useRealtimeRefetch } from "../hooks/useEvents";
import { fmtBytes, fmtDate, fmtSeconds, truncate } from "../labels";
import { useJobActions } from "./batch/useJobActions";

interface Group {
  key: string;
  title: string;
  batchId: string | null;
  items: LibraryItem[];
}

function Preview({ item, onClose, onToggleLibrary, onDelete }: { item: LibraryItem; onClose: () => void; onToggleLibrary: () => void; onDelete: () => void }) {
  return (
    <Modal
      open
      size="lg"
      title={item.fileName}
      subtitle={[item.batchName, item.sessionTitle].filter(Boolean).join(" · ") || undefined}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" icon={<Trash2 size={15} />} onClick={onDelete}>
            Xóa video
          </Button>
          <Button icon={item.inLibrary ? <BookmarkMinus size={15} /> : <BookmarkPlus size={15} />} onClick={onToggleLibrary}>
            {item.inLibrary ? "Bỏ khỏi Thư viện" : "Thêm vào Thư viện"}
          </Button>
          <LinkButton variant="primary" href={item.urls.download} icon={<Download size={15} />}>
            Tải video
          </LinkButton>
        </>
      }
    >
      <div className="preview-layout">
        <VideoPlayer src={item.urls.preview} poster={item.urls.thumbnail} download={item.urls.download} autoPlay />
        <div className="preview-meta">
          <div className="chip-row">
            <VersionBadge version={item.version} />
            {item.inLibrary ? (
              <span className="badge tone-success">
                <BookmarkCheck size={12} /> Trong thư viện
              </span>
            ) : null}
          </div>
          <dl className="kv">
            <dt>Thời lượng</dt>
            <dd>{fmtSeconds(item.durationSec)}</dd>
            <dt>Kích thước</dt>
            <dd>
              {item.width && item.height ? `${item.width}×${item.height} · ` : ""}
              {fmtBytes(item.sizeBytes)}
            </dd>
            <dt>Tạo lúc</dt>
            <dd>{fmtDate(item.createdAt)}</dd>
          </dl>
          {item.prompt ? (
            <div className="prompt-box">
              <div className="field-label">Prompt</div>
              <p>{item.prompt}</p>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

export function LibraryPage() {
  const [libraryOnly, setLibraryOnly] = useLocalStorage<boolean>("bvs.library.only", false);
  const [groupBy, setGroupBy] = useLocalStorage<"batch" | "session">("bvs.library.group", "batch");
  const lib = useApi(() => api.library(libraryOnly).then((r) => r.items), [libraryOnly]);
  useRealtimeRefetch((ev) => ev.type === "local.library" || ev.type === "asset.deleted" || ev.type === "batch.deleted" || (ev.type === "job.status" && ev.to === "completed"), () => void lib.reload(), 800);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<LibraryItem | null>(null);
  const actions = useJobActions();

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const it of lib.data ?? []) {
      const merged = it.origin === "merge";
      const key = merged ? "__merged" : groupBy === "batch" ? (it.batchId ?? "none") : (it.sessionId ?? "none");
      const title = merged ? "Video đã ghép / đã dựng" : groupBy === "batch" ? (it.batchName ?? "Không thuộc batch") : (it.sessionTitle ?? "Không thuộc phiên");
      if (!map.has(key)) map.set(key, { key, title, batchId: merged ? null : groupBy === "batch" ? it.batchId : null, items: [] });
      map.get(key)!.items.push(it);
    }
    return [...map.values()].sort((x, y) => (y.key === "__merged" ? 1 : 0) - (x.key === "__merged" ? 1 : 0));
  }, [lib.data, groupBy]);

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const ids = [...selected];
  const setLib = async (assetIds: string[], inLibrary: boolean) => {
    await actions.addToLibrary(assetIds, inLibrary);
    await lib.reload();
  };

  /** Xóa hẳn video khỏi máy - hook tự hỏi xác nhận */
  const removeAssets = async (assetIds: string[], label?: string) => {
    if (!(await actions.deleteAssets(assetIds, label))) return;
    setSelected((s) => {
      const n = new Set(s);
      for (const id of assetIds) n.delete(id);
      return n;
    });
    setPreview((p) => (p && assetIds.includes(p.id) ? null : p));
    await lib.reload();
  };

  return (
    <div className="page-stack">
      <section className="card">
        <div className="card-head">
          <div className="card-title">
            <Library size={16} aria-hidden /> Thư viện video
            {lib.data ? <span className="muted small">· {lib.data.length} video</span> : null}
          </div>
          <div className="card-head-actions">
            <Toggle checked={libraryOnly} onChange={setLibraryOnly} label="Chỉ mục đã thêm vào thư viện" />
            <Segmented
              ariaLabel="Nhóm theo"
              value={groupBy}
              onChange={setGroupBy}
              options={[
                { id: "batch", label: "Theo batch" },
                { id: "session", label: "Theo phiên" },
              ]}
            />
            <IconButton label="Tải lại" icon={<RefreshCw size={14} className={lib.refreshing ? "spin" : undefined} />} onClick={() => void lib.reload()} />
          </div>
        </div>

        <div className={`bulk-bar${selected.size ? " is-on" : ""}`}>
          {selected.size ? (
            <>
              <span className="small">{selected.size} video đã chọn</span>
              <Button size="sm" icon={<FileArchive size={14} />} loading={actions.busy === "zip"} onClick={() => void actions.downloadZip(ids, "thu-vien")}>
                Tải ZIP
              </Button>
              <Button size="sm" variant="primary" icon={<Film size={14} />} loading={actions.busy === "merge"} disabled={selected.size < 2} onClick={() => void actions.mergeVideos(ids).then(async (ok) => { if (ok) { setSelected(new Set()); await lib.reload(); } })}>
                Ghép thành 1 video
              </Button>
              <Button size="sm" icon={<Film size={14} />} loading={actions.busy === "autoedit"} disabled={selected.size < 2} onClick={() => void actions.autoEdit(ids, window.prompt("Yêu cầu dựng cho AI (để trống = tự quyết):", "") || undefined).then(async (ok) => { if (ok) { setSelected(new Set()); await lib.reload(); } })}>
                AI tự dựng
              </Button>
              <Button size="sm" variant="primary" icon={<Film size={14} />} disabled={selected.size < 2} onClick={() => void actions.proEdit(ids, window.prompt("Yêu cầu dựng nâng cao (tiêu đề, caption, phong cách...). Để trống = tự quyết:", "") || undefined).then((ok) => { if (ok) setSelected(new Set()); })}>
                Dựng nâng cao (Claude Code)
              </Button>
              <Button size="sm" icon={<BookmarkPlus size={14} />} onClick={() => void setLib(ids, true)}>
                Thêm vào Thư viện
              </Button>
              <Button size="sm" icon={<BookmarkMinus size={14} />} onClick={() => void setLib(ids, false).then(() => setSelected(new Set()))}>
                Bỏ khỏi Thư viện
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={14} />} loading={actions.busy === "delete"} onClick={() => void removeAssets(ids)}>
                Xóa vĩnh viễn
              </Button>
              <IconButton label="Bỏ chọn" icon={<X size={14} />} onClick={() => setSelected(new Set())} />
            </>
          ) : (
            <span className="muted small">Chọn video để tải ZIP hoặc quản lý thư viện. Video đã tạo xong tự xuất hiện ở đây.</span>
          )}
        </div>

        {lib.error ? <ErrorBanner error={lib.error} onRetry={lib.reload} /> : null}
        {lib.loading ? <div className="skeleton" style={{ height: 200 }} /> : null}
        {lib.data && !lib.data.length ? (
          <EmptyState icon={<Film size={22} />} title={libraryOnly ? "Chưa có video nào được thêm vào thư viện" : "Chưa có video nào được tạo"} description={libraryOnly ? "Tắt bộ lọc để xem mọi video đã tạo, hoặc bấm “Thêm vào Thư viện” ở trình xem video." : "Tạo và duyệt một batch ở Batch Studio."} />
        ) : null}

        {groups.map((g) => {
          const all = g.items.every((i) => selected.has(i.id));
          return (
            <div key={g.key} className="lib-group">
              <div className="lib-group-head">
                <Checkbox
                  ariaLabel={`Chọn cả nhóm ${g.title}`}
                  checked={all}
                  indeterminate={!all && g.items.some((i) => selected.has(i.id))}
                  onChange={(on) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      for (const i of g.items) {
                        if (on) n.add(i.id);
                        else n.delete(i.id);
                      }
                      return n;
                    })
                  }
                />
                <h3 className="lib-group-title">{g.title}</h3>
                <span className="muted small">{g.items.length} video</span>
                <span className="spacer" />
                {g.batchId ? (
                  <div className="btn-group" role="group" aria-label="Xuất batch">
                    <LinkButton size="sm" href={exportUrls.batch(g.batchId, "zip")} icon={<Download size={14} />}>
                      ZIP
                    </LinkButton>
                    <LinkButton size="sm" href={exportUrls.batch(g.batchId, "csv")}>
                      CSV
                    </LinkButton>
                    <LinkButton size="sm" href={exportUrls.batch(g.batchId, "json")}>
                      JSON
                    </LinkButton>
                    <LinkButton size="sm" href={exportUrls.batch(g.batchId, "txt")}>
                      TXT
                    </LinkButton>
                  </div>
                ) : null}
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 size={14} />}
                  loading={actions.busy === "delete"}
                  onClick={() => void removeAssets(g.items.map((i) => i.id), `Toàn bộ ${g.items.length} video của "${g.title}"`)}
                >
                  Xóa nhóm
                </Button>
              </div>
              <div className="lib-grid">
                {g.items.map((it) => (
                  <article key={it.id} className={`lib-card${selected.has(it.id) ? " is-selected" : ""}`} title={it.prompt ?? it.fileName}>
                    <button type="button" className="lib-thumb" onClick={() => setPreview(it)} aria-label={`Xem ${it.fileName}`}>
                      <img src={it.urls.thumbnail} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                      <span className="thumb-play" aria-hidden />
                      <span className="asset-duration mono">{fmtSeconds(it.durationSec)}</span>
                    </button>
                    <div className="lib-overlay">
                      <Checkbox ariaLabel={`Chọn ${it.fileName}`} checked={selected.has(it.id)} onChange={(on) => toggle(it.id, on)} />
                      <VersionBadge version={it.version} />
                      {it.inLibrary ? <BookmarkCheck size={14} className="text-success" aria-label="Trong thư viện" /> : null}
                    </div>
                    <div className="lib-body">
                      <div className="lib-prompt">{it.prompt ? truncate(it.prompt, 80) : it.fileName}</div>
                      <div className="muted tiny">{fmtDate(it.createdAt)}</div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          );
        })}
      </section>
      {preview ? (
        <Preview
          item={preview}
          onClose={() => setPreview(null)}
          onToggleLibrary={() => {
            const next = !preview.inLibrary;
            void setLib([preview.id], next).then(() => setPreview({ ...preview, inLibrary: next }));
          }}
          onDelete={() => void removeAssets([preview.id], preview.fileName)}
        />
      ) : null}
      {actions.dialog}
    </div>
  );
}
