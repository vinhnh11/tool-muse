import type { Approval, AudioCoverage, BatchStatus, GenerationMode, JobStatus, PricingKind } from "./api";

export type Tone = "neutral" | "accent" | "info" | "success" | "warning" | "danger" | "muted" | "violet" | "cyan";

export const JOB_STATUS_META: Record<JobStatus, { label: string; tone: Tone }> = {
  draft: { label: "Nháp", tone: "muted" },
  awaiting_approval: { label: "Chờ duyệt", tone: "violet" },
  queued: { label: "Trong hàng đợi", tone: "neutral" },
  waiting_for_capacity: { label: "Chờ slot", tone: "warning" },
  submitting: { label: "Đang gửi", tone: "cyan" },
  processing: { label: "Đang tạo", tone: "accent" },
  completed: { label: "Hoàn thành", tone: "success" },
  failed: { label: "Lỗi", tone: "danger" },
  cancelled: { label: "Đã hủy", tone: "muted" },
};

export const BATCH_STATUS_META: Record<BatchStatus, { label: string; tone: Tone }> = {
  draft: { label: "Nháp", tone: "muted" },
  awaiting_approval: { label: "Chờ duyệt", tone: "violet" },
  running: { label: "Đang chạy", tone: "accent" },
  paused: { label: "Tạm dừng", tone: "warning" },
  completed: { label: "Hoàn thành", tone: "success" },
  cancelled: { label: "Đã hủy", tone: "muted" },
};

export const ANALYSIS_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Trong hàng đợi", tone: "neutral" },
  running: { label: "Đang phân tích", tone: "accent" },
  completed: { label: "Hoàn thành", tone: "success" },
  failed: { label: "Lỗi", tone: "danger" },
};

export const APPROVAL_META: Record<Approval, { label: string; tone: Tone }> = {
  pending: { label: "Chờ duyệt", tone: "neutral" },
  approved: { label: "Đã duyệt", tone: "success" },
  rejected: { label: "Đã loại", tone: "danger" },
};

export const PROVIDER_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Đang hoạt động", tone: "success" },
  disabled: { label: "Đã tắt", tone: "muted" },
  needs_key: { label: "Thiếu API key", tone: "warning" },
};

export const MODE_LABEL: Record<GenerationMode, string> = {
  "text-to-video": "Văn bản → video",
  "image-to-video": "Ảnh → video",
  "reference-to-video": "Ảnh tham chiếu → video",
};

export const QUALITY_LABEL: Record<string, string> = {
  fast: "Nhanh",
  quality: "Chất lượng cao",
};

export const PRICING_LABEL: Record<PricingKind, string> = {
  "free-mock": "Mock - miễn phí",
  "user-configured": "Theo đơn giá bạn nhập",
  // Gồm cả muse2api: không tính tiền theo request nhưng TIÊU HẠN MỨC tài khoản → không được hiểu là miễn phí
  unknown: "Không xác định (phải tự xác nhận khi chạy)",
};

export const CANCEL_LABEL: Record<string, string> = {
  none: "Không hủy được ở provider",
  queued_only: "Chỉ hủy khi còn xếp hàng",
  any: "Hủy được mọi lúc",
};

export const GENRES: { id: string; label: string }[] = [
  { id: "product", label: "Quảng cáo sản phẩm" },
  { id: "talking-head", label: "Người nói (talking head)" },
  { id: "cinematic", label: "Điện ảnh (cinematic)" },
  { id: "motion-graphics", label: "Đồ họa chuyển động" },
  { id: "lifestyle", label: "Phong cách sống" },
  { id: "ugc-review", label: "Review kiểu UGC" },
  { id: "tutorial", label: "Hướng dẫn" },
  { id: "unboxing", label: "Đập hộp (unboxing)" },
];

export const AUDIO_COVERAGE_TEXT: Record<AudioCoverage, { text: string; tone: Tone }> = {
  analyzed: { text: "Đã phân tích âm thanh", tone: "success" },
  not_configured: { text: "Chưa cấu hình model nghe - chưa phân tích âm thanh", tone: "warning" },
  no_audio_track: { text: "Video không có tiếng", tone: "muted" },
  failed: { text: "Phân tích âm thanh lỗi", tone: "danger" },
};

export const EVENT_TYPE_LABEL: Record<string, string> = {
  "job.status": "Đổi trạng thái",
  "job.progress": "Tiến độ",
  "job.created": "Tạo phiên bản",
  "batch.created": "Tạo batch",
  "batch.approved": "Duyệt batch",
  "batch.paused": "Tạm dừng",
  "batch.resumed": "Tiếp tục",
  "batch.status": "Trạng thái batch",
  "analysis.status": "Phân tích",
  "analysis.progress": "Tiến độ phân tích",
  "prompts.progress": "Sinh prompt",
};

export function statusLabel(s: string | null | undefined): string {
  if (!s) return "-";
  return (JOB_STATUS_META as Record<string, { label: string }>)[s]?.label ?? (BATCH_STATUS_META as Record<string, { label: string }>)[s]?.label ?? s;
}

// ------------------------------------------------------------------ định dạng

const nf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 4 });

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return nf.format(n);
}

export function fmtCost(n: number | null | undefined, currency = "USD"): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "Không xác định";
  return `${nf.format(n)} ${currency}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "vừa xong";
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return fmtDate(iso);
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n && n !== 0) return "-";
  const u = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function fmtSeconds(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "-";
  if (sec < 0) return "Model tự chọn";
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTimecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function plural(n: number, word: string): string {
  return `${fmtNumber(n)} ${word}`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function isLlmError(code: string | undefined | null): boolean {
  return Boolean(code && code.startsWith("LLM_"));
}

/** LLM_NOT_CONFIGURED, LLM_TEXT_MODEL_NOT_CONFIGURED, LLM_VISION_MODEL_NOT_CONFIGURED... */
export function isLlmNotConfigured(code: string | undefined | null): boolean {
  return Boolean(code && /^LLM_.*NOT_CONFIGURED$/.test(code));
}
