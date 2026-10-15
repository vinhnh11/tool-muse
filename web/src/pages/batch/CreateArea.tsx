import { useRef, useState, type DragEvent } from "react";
import { AlertTriangle, Eraser, FileText, FileUp, ListPlus, Loader2, Upload, X } from "lucide-react";
import type { ApiError, ParseResult } from "../../api";
import { Button } from "../../components/Button";
import { ErrorBanner } from "../../components/EmptyState";
import { TextArea } from "../../components/Field";
import { fmtBytes, fmtNumber } from "../../labels";

export type CreateTab = "single" | "list" | "file" | "ai";

export const LIST_PLACEHOLDER = `Mỗi dòng là MỘT prompt = MỘT video. Ví dụ:
Cận cảnh chai serum xoay chậm trên nền đá cẩm thạch, ánh sáng studio mềm, 9:16
Cô gái thoa serum lên má trước gương phòng tắm buổi sáng, ánh nắng ấm
Sản phẩm rơi vào mặt nước, giọt nước bắn chậm, ánh sáng xanh mát`;

/** Bộ đếm dòng trực tiếp: "50 dòng → 50 video", dòng trống, trùng, gần trùng */
export function LineCounter({ parse, loading, error, variants, onClean }: { parse: ParseResult | null; loading: boolean; error: ApiError | null; variants: number; onClean?: () => void }) {
  if (error) return <ErrorBanner error={error} compact />;
  if (!parse)
    return loading ? (
      <div className="line-counter is-loading">
        <Loader2 size={14} className="spin" /> Đang đếm dòng...
      </div>
    ) : null;
  const valid = parse.check.uniqueLines.length;
  const videos = valid * variants;
  const dups = parse.check.duplicates;
  const near = parse.check.nearDuplicates;
  const blanks = parse.blankLines;
  const canClean = parse.format === "txt" && (dups.length > 0 || blanks.length > 0);
  return (
    <div className="line-counter" aria-live="polite">
      <div className="line-counter-main">
        <span className="lc-big">
          {variants > 1 ? (
            <>
              {fmtNumber(valid)} prompt × {variants} lần → <strong>{fmtNumber(videos)} video</strong>
            </>
          ) : (
            <>
              {fmtNumber(valid)} dòng → <strong>{fmtNumber(videos)} video</strong>
            </>
          )}
        </span>
        {loading ? <Loader2 size={14} className="spin muted" aria-label="Đang cập nhật" /> : null}
        <span className="muted small">
          định dạng {parse.format.toUpperCase()} · tổng {fmtNumber(parse.check.totalLines)} dòng
        </span>
        {canClean && onClean ? (
          <Button size="sm" variant="ghost" icon={<Eraser size={14} />} onClick={onClean} title="Xóa dòng trống và dòng trùng khỏi danh sách">
            Dọn dòng trống & trùng
          </Button>
        ) : null}
      </div>
      <div className="lc-details">
        <span className={blanks.length ? "lc-chip tone-neutral" : "lc-chip tone-muted"}>
          {blanks.length} dòng trống{blanks.length ? ` (bỏ qua: ${blanks.slice(0, 12).join(", ")}${blanks.length > 12 ? "…" : ""})` : ""}
        </span>
        <span className={dups.length ? "lc-chip tone-danger" : "lc-chip tone-muted"}>{dups.length} dòng trùng</span>
        <span className={near.length ? "lc-chip tone-warning" : "lc-chip tone-muted"}>{near.length} gần trùng</span>
        {parse.errors.length ? <span className="lc-chip tone-danger">{parse.errors.length} lỗi đọc</span> : null}
      </div>
      {dups.length || near.length || parse.errors.length ? (
        <ul className="lc-list">
          {parse.errors.slice(0, 10).map((e, i) => (
            <li key={`e${i}`} className="text-danger">
              <AlertTriangle size={12} /> Dòng {e.line}: {e.message}
            </li>
          ))}
          {dups.slice(0, 15).map((d) => (
            <li key={`d${d.line}`}>
              <span className="line-no">Dòng {d.line}</span> trùng hệt dòng {d.duplicateOfLine} - sẽ bị chặn khi tạo batch
            </li>
          ))}
          {near.slice(0, 10).map((n) => (
            <li key={`n${n.line}`} className="text-warning">
              <span className="line-no">Dòng {n.line}</span> gần giống dòng {n.similarToLine} ({Math.round(n.score * 100)}%)
            </li>
          ))}
          {dups.length > 15 ? <li className="muted">… và {dups.length - 15} dòng trùng khác</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/** Nhập prompt từ file .txt / .csv / .json (đọc trên trình duyệt, kéo-thả được) */
export function FileImport({ file, onFile, onClear, onEdit }: { file: { name: string; size: number; text: string } | null; onFile: (f: File) => void; onClear: () => void; onEdit: (text: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };
  return (
    <div className="file-import">
      {!file ? (
        <div
          className={`dropzone${drag ? " is-drag" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") input.current?.click();
          }}
        >
          <FileUp size={28} aria-hidden />
          <div className="dropzone-title">Kéo thả file vào đây hoặc bấm để chọn</div>
          <div className="muted small">.txt (mỗi dòng một prompt) · .csv (cột prompt, title, duration, ratio...) · .json (mảng prompt)</div>
        </div>
      ) : (
        <>
          <div className="file-chip">
            <FileText size={16} aria-hidden />
            <span className="file-name">{file.name}</span>
            <span className="muted small">{fmtBytes(file.size)}</span>
            <span className="spacer" />
            <Button size="sm" variant="ghost" icon={<Upload size={14} />} onClick={() => input.current?.click()}>
              Chọn file khác
            </Button>
            <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onClear}>
              Bỏ file
            </Button>
          </div>
          <TextArea className="mono prompt-textarea" rows={10} value={file.text} onChange={(e) => onEdit(e.target.value)} spellCheck={false} aria-label="Nội dung file (sửa được)" />
          <div className="muted small">Bạn có thể sửa trực tiếp nội dung file ở trên trước khi kiểm tra.</div>
        </>
      )}
      <input
        ref={input}
        type="file"
        accept=".txt,.csv,.json,text/plain,text/csv,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function MakeSetButton({ onClick, busy, disabled }: { onClick: () => void; busy: boolean; disabled: boolean }) {
  return (
    <Button size="sm" variant="secondary" icon={<ListPlus size={14} />} loading={busy} disabled={disabled} onClick={onClick} title="Tạo bộ prompt để xem, sửa, duyệt từng dòng trước khi chạy">
      Tạo bộ prompt để duyệt
    </Button>
  );
}
