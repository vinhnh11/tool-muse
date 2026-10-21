import { useEffect, useMemo, useState } from "react";
import { Ban, Check, CheckCheck, ChevronDown, ChevronUp, Copy, Download, ListChecks, Pencil, Rocket, Trash2, Wand2, X } from "lucide-react";
import { api, asApiError, exportUrls, type ApiError, type Approval, type PromptItem, type PromptSet } from "../../api";
import { ApprovalBadge, Badge } from "../../components/Badge";
import { Button, IconButton, LinkButton } from "../../components/Button";
import { useDialogs } from "../../components/ConfirmDialog";
import { EmptyState, ErrorBanner } from "../../components/EmptyState";
import { Checkbox, Field, Input, Select, TextArea, Toggle } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { FilterChip } from "../../components/Tabs";
import { toastApiError, useToast } from "../../components/Toast";
import { useApi } from "../../hooks/useApi";
import { useRealtimeRefetch } from "../../hooks/useEvents";
import { fmtDate, fmtSeconds, truncate } from "../../labels";
import { useStudio } from "../../state/studio";
import type { ResolvedConfig } from "./useVideoConfig";

const SOURCE_LABEL: Record<string, string> = { ai: "AI sinh", import: "Nhập từ file/danh sách", manual: "Thủ công" };

function ItemEditor({ item, onClose, onSaved }: { item: PromptItem; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [objective, setObjective] = useState(item.objective);
  const [prompt, setPrompt] = useState(item.prompt);
  const [negative, setNegative] = useState(item.negative ?? "");
  const [duration, setDuration] = useState(item.durationSec === null ? "" : String(item.durationSec));
  const [ratio, setRatio] = useState(item.aspectRatio ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updatePromptItem(item.id, {
        title: title.trim(),
        objective: objective.trim(),
        prompt: prompt.trim(),
        negative: negative.trim() || null,
        durationSec: duration.trim() ? Number(duration) : null,
        aspectRatio: ratio.trim() || null,
      });
      onSaved();
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
      title={`Sửa prompt #${item.index}`}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Hủy
          </Button>
          <Button variant="primary" loading={busy} disabled={!prompt.trim()} onClick={save}>
            Lưu thay đổi
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Tiêu đề">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Mục tiêu">
          <Input value={objective} onChange={(e) => setObjective(e.target.value)} />
        </Field>
      </div>
      <Field label={`Prompt (${prompt.length} ký tự)`}>
        <TextArea rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} data-autofocus />
      </Field>
      <Field label="Negative prompt">
        <TextArea rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} />
      </Field>
      <div className="grid-2">
        <Field label="Thời lượng riêng (giây)" hint="Để trống = theo cấu hình batch">
          <Input type="number" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </Field>
        <Field label="Tỷ lệ riêng" hint="vd 9:16 - để trống = theo cấu hình batch">
          <Input value={ratio} onChange={(e) => setRatio(e.target.value)} />
        </Field>
      </div>
      <ErrorBanner error={error} compact />
    </Modal>
  );
}

export function PromptSetPanel({
  set,
  loading,
  error,
  reload,
  cfg,
  useSet,
  setUseSet,
  onlyApproved,
  setOnlyApproved,
  useItemOverrides,
  setUseItemOverrides,
  onDeploy,
}: {
  set: PromptSet | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => Promise<void>;
  cfg: ResolvedConfig;
  useSet: boolean;
  setUseSet: (v: boolean) => void;
  onlyApproved: boolean;
  setOnlyApproved: (v: boolean) => void;
  useItemOverrides: boolean;
  setUseItemOverrides: (v: boolean) => void;
  /** Mở dialog TRIỂN KHAI: mỗi prompt = 1 video */
  onDeploy: () => void;
}) {
  const { sessionId, activeSetId, setActiveSetId } = useStudio();
  const toast = useToast();
  const dialogs = useDialogs();
  const sets = useApi(() => api.promptSets(sessionId).then((r) => r.sets), [sessionId]);
  useRealtimeRefetch((ev) => ev.type === "local.promptSets" || ev.type === "prompts.progress", () => void sets.reload(), 500);
  const [filter, setFilter] = useState<"all" | Approval>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<PromptItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected(new Set());
    setFilter("all");
  }, [activeSetId]);
  useEffect(() => {
    if (set) void sets.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set?.counts.total, set?.counts.approved, set?.id]);

  const items = useMemo(() => (set?.items ?? []).filter((i) => filter === "all" || i.approval === filter), [set, filter]);
  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 } as Record<Approval, number>;
    for (const i of set?.items ?? []) c[i.approval]++;
    return c;
  }, [set]);
  const deployCount = onlyApproved ? counts.approved : counts.pending + counts.approved;
  const durationMismatch = useMemo(() => (set?.items ?? []).filter((i) => i.durationSec !== null && i.durationSec !== cfg.state.durationSec).length, [set, cfg.state.durationSec]);

  const run = async (id: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusyId(id);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      await reload();
    } catch (e) {
      toastApiError(toast, "Thao tác thất bại", e);
    } finally {
      setBusyId(null);
    }
  };

  const approveMany = (ids: string[] | "all", approval: Approval) => run("bulk", () => api.setApproval(set!.id, ids, approval), approval === "approved" ? "Đã duyệt" : approval === "rejected" ? "Đã loại" : "Đã đặt lại");

  const rewrite = async (item: PromptItem) => {
    if (!cfg.provider || !cfg.model) return toast.error("Chọn provider/model ở Cấu hình video trước.");
    const instruction = await dialogs.prompt({
      title: `AI viết lại prompt #${item.index}`,
      label: "Hướng dẫn cho AI",
      placeholder: "vd: thêm hook mạnh 2 giây đầu, đổi bối cảnh sang quán cà phê, ngắn gọn hơn",
      initial: "Viết lại hay hơn, khác biệt hơn",
      multiline: true,
      required: true,
      confirmLabel: "Viết lại",
    });
    if (instruction === null) return;
    await run(item.id, () => api.rewritePromptItem(item.id, { instruction, providerConfigId: cfg.provider!.id, modelId: cfg.model!.modelId }), "AI đã viết lại prompt");
  };

  const remove = async (item: PromptItem) => {
    if (!(await dialogs.confirm({ title: `Xóa prompt #${item.index}?`, body: truncate(item.prompt, 200), confirmLabel: "Xóa", danger: true }))) return;
    await run(item.id, () => api.deletePromptItem(item.id), "Đã xóa prompt");
  };

  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <ListChecks size={16} aria-hidden /> Duyệt bộ prompt
        </div>
        <div className="card-head-actions">
          <Select
            className="input-sm set-select"
            value={activeSetId ?? ""}
            onChange={(e) => setActiveSetId(e.target.value || null)}
            aria-label="Chọn bộ prompt"
            options={[{ value: "", label: sets.data?.length ? "- Chọn bộ prompt đã có -" : "Chưa có bộ prompt" }, ...(sets.data ?? []).map((s) => ({ value: s.id, label: `${s.name} (${s.counts.total}) · ${fmtDate(s.createdAt)}` }))]}
          />
          {set ? <IconButton label="Đóng bộ prompt" icon={<X size={14} />} onClick={() => setActiveSetId(null)} /> : null}
        </div>
      </div>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}
      {loading && activeSetId ? <div className="skeleton" style={{ height: 160 }} /> : null}
      {!activeSetId ? <EmptyState compact title="Chưa mở bộ prompt nào" description="Sinh prompt bằng AI, hoặc dán danh sách / nhập file rồi bấm “Tạo bộ prompt để duyệt” để xem, sửa, duyệt từng prompt trước khi chạy." /> : null}

      {set ? (
        <>
          <div className="set-meta">
            <strong>{set.name}</strong>
            <Badge tone="info">{SOURCE_LABEL[set.source] ?? set.source}</Badge>
            <span className="muted small">
              {set.counts.total} prompt · {set.counts.approved} đã duyệt · {set.counts.rejected} đã loại
            </span>
            <span className="spacer" />
            <Button
              variant="primary"
              icon={<Rocket size={15} />}
              disabled={!deployCount || !cfg.provider || !cfg.model}
              title={!cfg.provider || !cfg.model ? "Chọn provider/model ở Cấu hình video trước" : `${deployCount} prompt → ${deployCount} video`}
              onClick={onDeploy}
            >
              Triển khai {deployCount} video
            </Button>
          </div>
          <div className="set-options">
            <Toggle checked={useSet} onChange={setUseSet} label="Dùng bộ prompt này để tạo batch" />
            <Toggle checked={onlyApproved} onChange={setOnlyApproved} label="Chỉ dùng prompt đã duyệt" description={onlyApproved ? `${counts.approved} prompt sẽ được dùng` : `${counts.pending + counts.approved} prompt (bỏ prompt đã loại)`} />
            <Toggle checked={useItemOverrides} onChange={setUseItemOverrides} label="Giữ thời lượng/tỷ lệ riêng của từng prompt" description={durationMismatch && useItemOverrides ? `${durationMismatch} prompt có thời lượng khác cấu hình (${fmtSeconds(cfg.state.durationSec)})` : undefined} />
          </div>
          <div className="toolbar">
            <div className="chip-row">
              <FilterChip active={filter === "all"} onClick={() => setFilter("all")} count={set.items.length}>
                Tất cả
              </FilterChip>
              <FilterChip active={filter === "pending"} onClick={() => setFilter("pending")} count={counts.pending}>
                Chờ duyệt
              </FilterChip>
              <FilterChip active={filter === "approved"} onClick={() => setFilter("approved")} count={counts.approved}>
                Đã duyệt
              </FilterChip>
              <FilterChip active={filter === "rejected"} onClick={() => setFilter("rejected")} count={counts.rejected}>
                Đã loại
              </FilterChip>
            </div>
            <span className="spacer" />
            {selected.size ? (
              <>
                <span className="muted small">{selected.size} đã chọn</span>
                <Button size="sm" icon={<Check size={14} />} onClick={() => void approveMany([...selected], "approved").then(() => setSelected(new Set()))}>
                  Duyệt
                </Button>
                <Button size="sm" icon={<Ban size={14} />} onClick={() => void approveMany([...selected], "rejected").then(() => setSelected(new Set()))}>
                  Loại
                </Button>
              </>
            ) : null}
            <Button size="sm" variant="secondary" icon={<CheckCheck size={14} />} loading={busyId === "bulk"} onClick={() => void approveMany("all", "approved")}>
              Duyệt tất cả
            </Button>
            <div className="btn-group" role="group" aria-label="Xuất bộ prompt">
              <LinkButton size="sm" href={exportUrls.promptSet(set.id, "txt", onlyApproved)} icon={<Download size={14} />}>
                TXT
              </LinkButton>
              <LinkButton size="sm" href={exportUrls.promptSet(set.id, "csv", onlyApproved)}>
                CSV
              </LinkButton>
              <LinkButton size="sm" href={exportUrls.promptSet(set.id, "json", onlyApproved)}>
                JSON
              </LinkButton>
            </div>
          </div>

          {items.length ? (
            <div className="table-wrap">
              <table className="table prompt-table">
                <thead>
                  <tr>
                    <th className="col-check">
                      <Checkbox ariaLabel="Chọn tất cả" checked={allSelected} indeterminate={!allSelected && items.some((i) => selected.has(i.id))} onChange={(on) => setSelected(on ? new Set(items.map((i) => i.id)) : new Set())} />
                    </th>
                    <th className="col-num">#</th>
                    <th>Tiêu đề</th>
                    <th>Prompt</th>
                    <th className="col-narrow">Thời lượng</th>
                    <th className="col-narrow">Tỷ lệ</th>
                    <th className="col-narrow">Trạng thái</th>
                    <th className="col-actions">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const open = expanded.has(it.id);
                    const busy = busyId === it.id;
                    return (
                      <tr key={it.id} className={`approval-${it.approval}${busy ? " is-busy" : ""}`}>
                        <td className="col-check">
                          <Checkbox
                            ariaLabel={`Chọn prompt ${it.index}`}
                            checked={selected.has(it.id)}
                            onChange={(on) =>
                              setSelected((s) => {
                                const n = new Set(s);
                                if (on) n.add(it.id);
                                else n.delete(it.id);
                                return n;
                              })
                            }
                          />
                        </td>
                        <td className="col-num mono">{it.index}</td>
                        <td className="col-title" data-label="Tiêu đề">
                          {it.title || <span className="muted">-</span>}
                          {it.genre ? <div className="muted tiny">{it.genre}</div> : null}
                        </td>
                        <td className="col-prompt" data-label="Prompt">
                          <div className={open ? "prompt-full" : "prompt-clamp"}>{it.prompt}</div>
                          {it.negative && open ? (
                            <div className="muted small">
                              <strong>Negative:</strong> {it.negative}
                            </div>
                          ) : null}
                          {it.prompt.length > 140 || it.negative ? (
                            <button type="button" className="link-btn" onClick={() => toggleExpand(it.id)}>
                              {open ? (
                                <>
                                  Thu gọn <ChevronUp size={12} />
                                </>
                              ) : (
                                <>
                                  Xem đủ <ChevronDown size={12} />
                                </>
                              )}
                            </button>
                          ) : null}
                        </td>
                        <td className="col-narrow" data-label="Thời lượng">
                          {it.durationSec !== null ? fmtSeconds(it.durationSec) : <span className="muted">theo batch</span>}
                        </td>
                        <td className="col-narrow" data-label="Tỷ lệ">
                          {it.aspectRatio ?? <span className="muted">theo batch</span>}
                        </td>
                        <td className="col-narrow">
                          <ApprovalBadge approval={it.approval} />
                        </td>
                        <td className="col-actions">
                          <div className="row-actions">
                            {it.approval !== "approved" ? <IconButton label="Duyệt" icon={<Check size={14} />} onClick={() => void run(it.id, () => api.setApproval(set.id, [it.id], "approved"))} disabled={busy} /> : null}
                            {it.approval !== "rejected" ? <IconButton label="Loại" icon={<Ban size={14} />} onClick={() => void run(it.id, () => api.setApproval(set.id, [it.id], "rejected"))} disabled={busy} /> : null}
                            <IconButton label="Sửa" icon={<Pencil size={14} />} onClick={() => setEditing(it)} disabled={busy} />
                            <IconButton label="AI viết lại" icon={<Wand2 size={14} />} loading={busy} onClick={() => void rewrite(it)} disabled={busy} />
                            <IconButton label="Nhân bản" icon={<Copy size={14} />} onClick={() => void run(it.id, () => api.duplicatePromptItem(it.id), "Đã nhân bản")} disabled={busy} />
                            <IconButton label="Xóa" icon={<Trash2 size={14} />} onClick={() => void remove(it)} disabled={busy} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState compact title="Không có prompt nào ở bộ lọc này" />
          )}
        </>
      ) : null}
      {editing ? <ItemEditor item={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} /> : null}
    </section>
  );
}
