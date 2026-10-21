import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, FolderOpen, ListChecks, PlayCircle, ShieldQuestion, Wrench } from "lucide-react";
import type { ChatMessage } from "../api";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { PRICING_LABEL, fmtCost, truncate } from "../labels";
import { useStudio } from "../state/studio";

type Json = Record<string, unknown>;

const TOOL_LABEL: Record<string, string> = {
  video_list_assets: "Liệt kê video",
  video_get_provider_capabilities: "Xem khả năng provider",
  video_generate_prompts: "Sinh prompt",
  video_import_prompts: "Nhập prompt",
  video_estimate_batch: "Ước tính batch",
  video_create_batch: "Tạo batch",
  video_approve_batch: "Duyệt batch",
  video_deploy_prompt_set: "Triển khai bộ prompt",
  video_get_batch_status: "Trạng thái batch",
  video_pause_batch: "Tạm dừng batch",
  video_resume_batch: "Tiếp tục batch",
  video_cancel_job: "Hủy job",
  video_retry_job: "Tạo lại job",
  video_get_result: "Kết quả job",
  video_regenerate: "Tạo phiên bản mới",
  video_export_batch: "Xuất batch",
};

export function toolLabel(name: string | null | undefined): string {
  return (name && TOOL_LABEL[name]) || name || "Công cụ";
}

function parse(content: string): Json | null {
  try {
    const v = JSON.parse(content) as unknown;
    return v && typeof v === "object" ? (v as Json) : null;
  } catch {
    return null;
  }
}

function RawJson({ title, data, raw }: { title: string; data: Json | null; raw: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-card tool-raw">
      <button type="button" className="tool-raw-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={13} aria-hidden />
        <span>{title}</span>
      </button>
      {open ? <pre className="code-block">{data ? JSON.stringify(data, null, 2) : raw}</pre> : null}
    </div>
  );
}

/** Thẻ kết quả tool trong chat (không hiện JSON thô mặc định) */
export function ToolCard({ msg }: { msg: ChatMessage }) {
  const { openApproval, setActiveSetId, setSelectedBatchId, navigate } = useStudio();
  const data = parse(msg.content);
  const name = msg.toolName ?? "";

  if (data && data.error && typeof data.error === "object") {
    const err = data.error as { code?: string; message?: string };
    return (
      <div className="tool-card tool-error">
        <div className="tool-card-head">
          <AlertTriangle size={15} aria-hidden />
          <strong>{toolLabel(name)} lỗi</strong>
          {err.code ? <code className="tiny">{err.code}</code> : null}
        </div>
        <div className="small">{err.message ?? "Lỗi không rõ"}</div>
        {err.code?.startsWith("LLM_") ? (
          <a className="link small" href="#/settings">
            Mở Cài đặt LLM
          </a>
        ) : null}
      </div>
    );
  }

  if (data && data.needsUserApproval === true) {
    const batchId = typeof data.batchId === "string" ? data.batchId : null;
    const isRetry = data.kind === "retry";
    return (
      <div className="tool-card tool-approval">
        <div className="tool-card-head">
          <ShieldQuestion size={15} aria-hidden />
          <strong>Cần bạn xác nhận</strong>
        </div>
        <div className="small">{String(data.message ?? "Thao tác có thể tốn phí - hãy xác nhận trên giao diện.")}</div>
        {typeof data.estimate === "number" ? <div className="small">Ước tính: {fmtCost(data.estimate, String(data.currency ?? "USD"))}</div> : null}
        <div className="tool-card-actions">
          {batchId && !isRetry ? (
            <Button size="sm" variant="primary" icon={<PlayCircle size={14} />} onClick={() => openApproval(batchId)}>
              Duyệt & chạy
            </Button>
          ) : null}
          {batchId ? (
            <Button
              size="sm"
              icon={<FolderOpen size={14} />}
              onClick={() => {
                setSelectedBatchId(batchId);
                navigate("batch");
              }}
            >
              Mở batch
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (name === "video_create_batch" && data && typeof data.batchId === "string") {
    const est = (data.estimate ?? {}) as { total?: number | null; currency?: string; kind?: string; effectiveConcurrency?: number; notes?: string[] };
    const batchId = data.batchId;
    return (
      <div className="tool-card tool-batch">
        <div className="tool-card-head">
          <ListChecks size={15} aria-hidden />
          <strong>Batch chờ duyệt</strong>
          <Badge tone="violet">Chờ duyệt</Badge>
        </div>
        <div className="tool-card-summary">{String(data.summary ?? "")}</div>
        <div className="small">
          Chi phí ước tính: <strong>{est.total === null || est.total === undefined ? "Không xác định" : fmtCost(est.total, est.currency ?? "USD")}</strong>
          {est.kind ? <span className="muted"> · {PRICING_LABEL[est.kind as keyof typeof PRICING_LABEL] ?? est.kind}</span> : null}
          {est.effectiveConcurrency ? <span className="muted"> · {est.effectiveConcurrency} luồng</span> : null}
        </div>
        <div className="tool-card-actions">
          <Button size="sm" variant="primary" icon={<PlayCircle size={14} />} onClick={() => openApproval(batchId)}>
            Duyệt & chạy
          </Button>
          <Button
            size="sm"
            icon={<FolderOpen size={14} />}
            onClick={() => {
              setSelectedBatchId(batchId);
              navigate("batch");
            }}
          >
            Mở batch
          </Button>
        </div>
      </div>
    );
  }

  if ((name === "video_generate_prompts" || name === "video_import_prompts") && data && typeof data.promptSetId === "string") {
    const setId = data.promptSetId;
    const preview = Array.isArray(data.preview) ? (data.preview as { index: number; title: string; prompt: string }[]) : [];
    const count = typeof data.generated === "number" ? `${data.generated}/${String(data.requested ?? data.generated)} prompt` : typeof data.count === "number" ? `${data.count} prompt` : "";
    return (
      <div className="tool-card tool-prompts">
        <div className="tool-card-head">
          <ListChecks size={15} aria-hidden />
          <strong>Bộ prompt {data.name ? `“${String(data.name)}”` : ""}</strong>
          {count ? <Badge tone="info">{count}</Badge> : null}
        </div>
        {data.message || data.summary ? <div className="small">{String(data.message ?? data.summary)}</div> : null}
        {preview.length ? (
          <ol className="tool-preview">
            {preview.map((p) => (
              <li key={p.index}>
                {p.title ? <strong>{p.title}: </strong> : null}
                {truncate(p.prompt, 120)}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="tool-card-actions">
          <Button
            size="sm"
            variant="primary"
            icon={<ExternalLink size={14} />}
            onClick={() => {
              setActiveSetId(setId);
              navigate("batch");
            }}
          >
            Mở để duyệt
          </Button>
        </div>
      </div>
    );
  }

  return <RawJson title={`Kết quả: ${toolLabel(name)}`} data={data} raw={msg.content} />;
}
