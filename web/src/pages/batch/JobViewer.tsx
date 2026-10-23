import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Columns2, Download, Film, GitBranchPlus, History, Info, Library, Loader2, Play, RotateCcw, Send, Ban } from "lucide-react";
import { api, asApiError, IMAGE_ASPECT_RATIOS, TERMINAL_JOB_STATUSES, type ApiError, type Batch, type Job } from "../../api";
import { JobStatusBadge, VersionBadge } from "../../components/Badge";
import { Button, LinkButton } from "../../components/Button";
import { EmptyState, ErrorBanner, Loading } from "../../components/EmptyState";
import { Checkbox, Field, Input, Select, TextArea } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { ProgressBar } from "../../components/ProgressBar";
import { Tabs } from "../../components/Tabs";
import { toastApiError, useToast } from "../../components/Toast";
import { VideoPlayer, type VideoPlayerHandle } from "../../components/VideoPlayer";
import { useApi } from "../../hooks/useApi";
import { useRealtimeRefetch } from "../../hooks/useEvents";
import { EVENT_TYPE_LABEL, MODE_LABEL, QUALITY_LABEL, fmtCost, fmtDate, fmtSeconds, fmtTime, statusLabel, truncate } from "../../labels";
import { useStudio } from "../../state/studio";
import { useJobActions } from "./useJobActions";

export type ViewerTab = "info" | "versions" | "regenerate" | "events";

function VideoOrPlaceholder({ job, autoPlay }: { job: Job; autoPlay?: boolean }) {
  if (job.output && job.kind === "image") return <img className="image-viewer" src={job.output.preview} alt={job.prompt} />;
  if (job.output) return <VideoPlayer src={job.output.preview} poster={job.output.thumbnail} download={job.output.download} title={`Job #${job.seq} V${job.version}`} autoPlay={autoPlay} />;
  const active = job.status === "processing" || job.status === "submitting";
  return (
    <div className="player-placeholder">
      {active ? <Loader2 size={24} className="spin" /> : job.status === "failed" ? <AlertTriangle size={24} className="text-danger" /> : <Film size={24} />}
      <JobStatusBadge status={job.status} />
      {active ? <ProgressBar value={job.status === "submitting" ? null : job.progress} /> : null}
      <span className="muted small">{job.status === "failed" ? (job.kind === "image" ? "Job lỗi - chưa có ảnh" : "Job lỗi - chưa có video") : job.status === "cancelled" ? "Job đã hủy" : job.kind === "image" ? "Ảnh sẽ hiện ngay khi Muse tạo xong" : "Video sẽ hiện ngay khi provider tạo xong"}</span>
    </div>
  );
}

function InfoTab({ job, batch }: { job: Job; batch: Batch }) {
  const toast = useToast();
  const actions = useJobActions(batch.currency);
  const [sending, setSending] = useState(false);
  const sendToEdit = async () => {
    if (!job.output) return;
    setSending(true);
    try {
      const r = await api.sendToEdit(job.output.assetId);
      toast.success("Đã đưa video sang thư mục chỉnh sửa", r.path);
    } catch (e) {
      const err = asApiError(e);
      if (err.code === "EDIT_INBOX_NOT_CONFIGURED") toast.error("Chưa cấu hình thư mục chỉnh sửa", "Quản trị viên cần đặt EDIT_INBOX_DIR trong file .env của máy chủ rồi khởi động lại.");
      else toastApiError(toast, "Không gửi được sang chỉnh sửa", e);
    } finally {
      setSending(false);
    }
  };
  const canCancel = !TERMINAL_JOB_STATUSES.includes(job.status) && batch.status !== "awaiting_approval";
  return (
    <div className="viewer-grid">
      <div className="viewer-media">
        <VideoOrPlaceholder job={job} autoPlay />
      </div>
      <div className="viewer-side">
        <div className="viewer-actions">
          {job.output ? (
            <LinkButton href={job.output.download} icon={<Download size={15} />} variant="primary">
              {job.kind === "image" ? "Tải ảnh" : "Tải video"}
            </LinkButton>
          ) : null}
          {job.output ? (
            <Button icon={<Library size={15} />} onClick={() => void actions.addToLibrary([job.output!.assetId])}>
              Thêm vào Thư viện
            </Button>
          ) : null}
          {job.output && job.kind !== "image" ? (
            <Button icon={<Send size={15} />} loading={sending} onClick={() => void sendToEdit()}>
              Đưa sang chỉnh sửa
            </Button>
          ) : null}
          {job.status === "awaiting_approval" && batch.status !== "awaiting_approval" ? (
            <Button variant="primary" icon={<Check size={15} />} onClick={() => actions.approveJobs([job])}>
              Duyệt & chạy
            </Button>
          ) : null}
          {canCancel ? (
            <Button icon={<Ban size={15} />} loading={actions.busy === `cancel:${job.id}`} onClick={() => void actions.cancelJob(job)}>
              Hủy job
            </Button>
          ) : null}
          {job.status === "failed" || job.status === "cancelled" ? (
            <Button icon={<RotateCcw size={15} />} onClick={() => void actions.retryJobs([job])}>
              Tạo lại
            </Button>
          ) : null}
        </div>
        {job.error ? <ErrorBanner error={{ code: job.error.code ?? undefined, message: [job.error.message, job.error.detail].filter(Boolean).join(" - ") || "Lỗi không rõ" }} /> : null}
        <dl className="kv">
          <dt>Trạng thái</dt>
          <dd>
            <JobStatusBadge status={job.status} /> {job.status === "processing" && job.progress !== null ? `${job.progress}%` : null}
          </dd>
          <dt>Phiên bản</dt>
          <dd>
            <VersionBadge version={job.version} /> {job.parentJobId ? <span className="muted small">từ {job.parentJobId}</span> : null}
          </dd>
          <dt>Provider / model</dt>
          <dd>
            {job.providerName} · <code>{job.modelId}</code>
          </dd>
          <dt>Cấu hình</dt>
          <dd>
            {job.kind === "image" ? job.config.aspectRatio : `${MODE_LABEL[job.config.mode]} · ${fmtSeconds(job.config.durationSec)} · ${job.config.aspectRatio} · ${job.config.resolution}`}
            {job.kind !== "image" && job.config.audio ? " · âm thanh" : ""}
            {job.kind !== "image" && job.config.quality ? ` · ${QUALITY_LABEL[job.config.quality] ?? job.config.quality}` : ""}
          </dd>
          <dt>Lần thử</dt>
          <dd>
            {job.attempt}/{job.maxAttempts}
            {job.nextAttemptAt ? <span className="muted small"> · thử lại lúc {fmtTime(job.nextAttemptAt)}</span> : null}
          </dd>
          <dt>Chi phí</dt>
          <dd>
            {job.kind === "image" ? "tiêu hạn mức nick Muse" : `ước tính ${fmtCost(job.estimatedCost, batch.currency)} · thực tế ${job.actualCost === null ? "chưa có" : fmtCost(job.actualCost, batch.currency)}`}
          </dd>
          {job.output?.durationSec ? (
            <>
              <dt>Độ dài video</dt>
              <dd>{fmtSeconds(job.output.durationSec)}</dd>
            </>
          ) : null}
          <dt>Thời gian</dt>
          <dd className="small">
            tạo {fmtDate(job.createdAt)}
            {job.submittedAt ? ` · gửi ${fmtTime(job.submittedAt)}` : ""}
            {job.completedAt ? ` · xong ${fmtTime(job.completedAt)}` : ""}
          </dd>
          {job.remoteJobId ? (
            <>
              <dt>Mã ở provider</dt>
              <dd>
                <code className="tiny">{job.remoteJobId}</code>
              </dd>
            </>
          ) : null}
          <dt>Job id</dt>
          <dd>
            <code className="tiny">{job.id}</code>
          </dd>
        </dl>
        {job.title ? <div className="strong">{job.title}</div> : null}
        <div className="prompt-box">
          <div className="field-label">Prompt</div>
          <p>{job.prompt}</p>
          {job.negative ? (
            <>
              <div className="field-label">Negative</div>
              <p className="muted">{job.negative}</p>
            </>
          ) : null}
        </div>
      </div>
      {actions.dialog}
    </div>
  );
}

function VersionsTab({ jobId, onOpenJob }: { jobId: string; onOpenJob: (id: string, tab?: ViewerTab) => void }) {
  const versions = useApi(() => api.jobVersions(jobId).then((r) => r.versions), [jobId]);
  useRealtimeRefetch((ev) => ev.type === "job.created" || ev.type === "job.status", () => void versions.reload(), 500);
  const [compare, setCompare] = useState<string[]>([]);
  const a = useRef<VideoPlayerHandle>(null);
  const b = useRef<VideoPlayerHandle>(null);
  const list = versions.data ?? [];
  useEffect(() => {
    const done = list.filter((v) => v.output);
    if (!compare.length && done.length >= 2) setCompare([done[done.length - 2]!.id, done[done.length - 1]!.id]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions.data]);
  const left = list.find((v) => v.id === compare[0]);
  const right = list.find((v) => v.id === compare[1]);

  const playBoth = () => {
    a.current?.seek(0);
    b.current?.seek(0);
    a.current?.play();
    b.current?.play();
  };

  if (versions.loading) return <Loading />;
  if (versions.error) return <ErrorBanner error={versions.error} onRetry={versions.reload} />;
  return (
    <div className="versions">
      <div className="version-list">
        {list.map((v) => (
          <div key={v.id} className={`version-item${v.id === jobId ? " is-current" : ""}`}>
            <div className="version-thumb">{v.output?.thumbnail ? <img src={v.output.thumbnail} alt="" loading="lazy" /> : <Film size={18} />}</div>
            <div className="version-body">
              <div className="version-row">
                <VersionBadge version={v.version} />
                <JobStatusBadge status={v.status} />
                {v.id === jobId ? <span className="muted tiny">đang xem</span> : null}
              </div>
              <div className="muted small" title={v.prompt}>
                {truncate(v.prompt, 90)}
              </div>
              <div className="muted tiny">{fmtDate(v.createdAt)}</div>
            </div>
            <div className="version-actions">
              <Checkbox
                checked={compare.includes(v.id)}
                disabled={!v.output}
                onChange={(on) => setCompare((xs) => (on ? [...xs.filter((x) => x !== v.id), v.id].slice(-2) : xs.filter((x) => x !== v.id)))}
                label="So sánh"
              />
              {v.id !== jobId ? (
                <Button size="sm" variant="ghost" onClick={() => onOpenJob(v.id)}>
                  Mở
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {list.length < 2 ? <EmptyState compact icon={<GitBranchPlus size={20} />} title="Chưa có phiên bản khác" description="Dùng tab “Sửa prompt & tạo lại” để tạo V2, V3... Bản cũ luôn được giữ." /> : null}
      {left && right ? (
        <div className="compare">
          <div className="compare-head">
            <Columns2 size={16} aria-hidden />
            <strong>
              So sánh V{left.version} và V{right.version}
            </strong>
            <span className="spacer" />
            <Button size="sm" icon={<Play size={14} />} onClick={playBoth}>
              Phát cả hai từ đầu
            </Button>
          </div>
          <div className="compare-grid">
            {[left, right].map((v, i) => (
              <div key={v.id} className="compare-col">
                <div className="compare-label">
                  <VersionBadge version={v.version} /> <JobStatusBadge status={v.status} />
                </div>
                {v.output ? <VideoPlayer ref={i === 0 ? a : b} src={v.output.preview} poster={v.output.thumbnail} download={v.output.download} compact /> : null}
                <p className="small compare-prompt">{v.prompt}</p>
              </div>
            ))}
          </div>
        </div>
      ) : list.length >= 2 ? (
        <div className="muted small">Chọn 2 phiên bản đã có video để so sánh.</div>
      ) : null}
    </div>
  );
}

function RegenerateTab({ job, batch, onCreated }: { job: Job; batch: Batch; onCreated: (j: Job) => void }) {
  const { providers } = useStudio();
  const model = useMemo(() => providers.find((p) => p.id === job.providerConfigId)?.capabilities.models.find((m) => m.modelId === job.modelId) ?? null, [providers, job]);
  const [prompt, setPrompt] = useState(job.prompt);
  const [negative, setNegative] = useState(job.negative ?? "");
  const [duration, setDuration] = useState(String(job.config.durationSec));
  const [ratio, setRatio] = useState(job.config.aspectRatio);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    setPrompt(job.prompt);
    setNegative(job.negative ?? "");
    setDuration(String(job.config.durationSec));
    setRatio(job.config.aspectRatio);
  }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = Math.round(Number(duration));
      const created = await api.regenerateJob(job.id, {
        prompt: prompt.trim(),
        ...(model?.negativePrompt ? { negative: negative.trim() || null } : {}),
        ...(Number.isFinite(d) && job.kind !== "image" ? { durationSec: d } : {}),
        aspectRatio: ratio,
      });
      onCreated(created);
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="regen">
      <p className="muted small">
        Tạo <strong>phiên bản mới</strong> (V{job.version + 1}+) từ job này - bản cũ được giữ nguyên. Phiên bản mới ở trạng thái <strong>Chờ duyệt</strong>; bạn xác nhận chi phí rồi mới chạy.
      </p>
      <Field label={`Prompt (${prompt.length}${model ? `/${model.maxPromptChars}` : ""} ký tự)`}>
        <TextArea rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      {model?.negativePrompt && job.kind !== "image" ? (
        <Field label="Negative prompt">
          <TextArea rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} />
        </Field>
      ) : null}
      <div className="grid-2">
        {job.kind === "image" ? null : <Field label="Thời lượng (giây)" hint={model ? `Model hỗ trợ ${model.durations.min}-${model.durations.max}s${model.durations.auto ? ", -1 = tự chọn" : ""}` : undefined}>
          <Input type="number" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </Field>}
        <Field label="Tỷ lệ khung">
          {job.kind === "image" ? <Select value={ratio} onChange={(e) => setRatio(e.target.value)} options={IMAGE_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))} /> : model ? <Select value={ratio} onChange={(e) => setRatio(e.target.value)} options={model.aspectRatios.map((r) => ({ value: r, label: r }))} /> : <Input value={ratio} onChange={(e) => setRatio(e.target.value)} />}
        </Field>
      </div>
      {batch.status === "awaiting_approval" ? <div className="banner banner-warning">Batch này chưa được duyệt - duyệt batch trước khi chạy phiên bản mới.</div> : null}
      <ErrorBanner error={error} />
      <div className="row-end">
        <Button variant="primary" icon={<GitBranchPlus size={16} />} loading={busy} disabled={!prompt.trim()} onClick={() => void submit()}>
          Sửa prompt & tạo lại
        </Button>
      </div>
    </div>
  );
}

function EventsTab({ jobId }: { jobId: string }) {
  const events = useApi(() => api.jobEvents(jobId).then((r) => r.events), [jobId]);
  useRealtimeRefetch((ev) => ev.jobId === jobId, () => void events.reload(), 400);
  if (events.loading) return <Loading />;
  if (events.error) return <ErrorBanner error={events.error} onRetry={events.reload} />;
  if (!events.data?.length) return <EmptyState compact title="Chưa có sự kiện" />;
  return (
    <ol className="timeline">
      {events.data.map((e) => (
        <li key={e.id} className="timeline-item">
          <span className="timeline-time mono">{fmtTime(e.created_at)}</span>
          <span className="timeline-dot" aria-hidden />
          <div className="timeline-body">
            <div>
              <strong>{EVENT_TYPE_LABEL[e.type] ?? e.type}</strong>
              {e.from_status || e.to_status ? (
                <span className="timeline-status">
                  {e.from_status ? statusLabel(e.from_status) : "-"} <ArrowRight size={12} /> {statusLabel(e.to_status)}
                </span>
              ) : null}
            </div>
            {e.message ? <div className="muted small">{e.message}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function JobViewer({ jobId, initialTab, batch, onClose, onOpenJob }: { jobId: string; initialTab: ViewerTab; batch: Batch; onClose: () => void; onOpenJob: (id: string, tab?: ViewerTab) => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<ViewerTab>(initialTab);
  useEffect(() => setTab(initialTab), [jobId, initialTab]);
  const job = useApi(() => api.job(jobId), [jobId]);
  useRealtimeRefetch((ev) => ev.jobId === jobId || (ev.type === "local.batch" && (!ev.batchId || ev.batchId === batch.id)), () => void job.reload(), 250);
  const actions = useJobActions(batch.currency);
  const j = job.data;

  return (
    <Modal
      open
      size="xl"
      onClose={onClose}
      title={
        j ? (
          <span className="viewer-title">
            Job #{j.seq} <VersionBadge version={j.version} /> <JobStatusBadge status={j.status} />
          </span>
        ) : (
          "Đang tải job..."
        )
      }
      subtitle={batch.name}
    >
      <Tabs
        size="sm"
        value={tab}
        onChange={setTab}
        items={[
          { id: "info", label: "Video & thông tin", icon: <Info size={14} /> },
          { id: "versions", label: "Phiên bản", icon: <Columns2 size={14} /> },
          { id: "regenerate", label: "Sửa prompt & tạo lại", icon: <GitBranchPlus size={14} /> },
          { id: "events", label: "Lịch sử", icon: <History size={14} /> },
        ]}
      />
      <div className="viewer-content">
        {job.error ? <ErrorBanner error={job.error} onRetry={job.reload} /> : null}
        {job.loading ? <Loading /> : null}
        {j && tab === "info" ? <InfoTab job={j} batch={batch} /> : null}
        {j && tab === "versions" ? <VersionsTab jobId={j.id} onOpenJob={onOpenJob} /> : null}
        {j && tab === "regenerate" ? (
          <RegenerateTab
            job={j}
            batch={batch}
            onCreated={(n) => {
              toast.success(`Đã tạo phiên bản V${n.version} - đang chờ duyệt`);
              onOpenJob(n.id, "info");
              if (n.status === "awaiting_approval" && batch.status !== "awaiting_approval") actions.approveJobs([n]);
            }}
          />
        ) : null}
        {j && tab === "events" ? <EventsTab jobId={j.id} /> : null}
      </div>
      {actions.dialog}
    </Modal>
  );
}
