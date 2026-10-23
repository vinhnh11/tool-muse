import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import type { Db } from "./db.ts";
import { makeImageThumbnail, makePreview, makeThumbnail, needsPreview, probe, type MediaTools } from "./media.ts";
import { AppError, newId, nowIso, redact } from "./util.ts";
import { ProviderError } from "./providers/types.ts";

export interface AssetRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  kind: string;
  origin: string;
  file_name: string;
  storage_path: string;
  preview_path: string | null;
  thumbnail_path: string | null;
  mime: string;
  size_bytes: number;
  sha256: string;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  video_codec: string | null;
  has_audio: number | null;
  source_job_id: string | null;
  source_attempt: number | null;
  in_library: number;
  created_by: string | null;
  created_at: string;
}

export interface AssetPublic {
  id: string;
  sessionId: string | null;
  kind: string;
  origin: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  hasAudio: boolean | null;
  inLibrary: boolean;
  sourceJobId: string | null;
  urls: { file: string; preview: string; thumbnail: string | null; download: string };
  createdAt: string;
}

const VIDEO_MIME: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".m4v": "video/mp4" };
const IMAGE_MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

export function mimeOf(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase();
  return VIDEO_MIME[ext] ?? IMAGE_MIME[ext] ?? null;
}

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 120);
  return base || "file";
}

export class Storage {
  readonly root: string;
  private db: Db;
  private media: MediaTools;

  constructor(db: Db, root: string, media: MediaTools) {
    this.db = db;
    this.root = root;
    this.media = media;
  }

  /** Đường dẫn tuyệt đối từ đường dẫn lưu tương đối - chặn thoát khỏi STORAGE_DIR */
  abs(rel: string): string {
    const p = path.resolve(this.root, rel);
    const rootResolved = path.resolve(this.root);
    if (p !== rootResolved && !p.startsWith(rootResolved + path.sep)) throw new AppError("BAD_PATH", "Đường dẫn file không hợp lệ.", 400);
    return p;
  }

  tmpDir(...parts: string[]): string {
    const d = path.join(this.root, "_tmp", ...parts);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  getRow(workspaceId: string, id: string): AssetRow {
    const r = this.db.get<AssetRow>("SELECT * FROM video_assets WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!r) throw new AppError("NOT_FOUND", "Không tìm thấy asset.", 404);
    return r;
  }

  toPublic(r: AssetRow): AssetPublic {
    return {
      id: r.id,
      sessionId: r.session_id,
      kind: r.kind,
      origin: r.origin,
      fileName: r.file_name,
      mime: r.mime,
      sizeBytes: r.size_bytes,
      sha256: r.sha256,
      durationSec: r.duration_sec,
      width: r.width,
      height: r.height,
      fps: r.fps,
      videoCodec: r.video_codec,
      hasAudio: r.has_audio === null ? null : Boolean(r.has_audio),
      inLibrary: Boolean(r.in_library),
      sourceJobId: r.source_job_id,
      urls: {
        file: `/api/assets/${r.id}/file`,
        preview: `/api/assets/${r.id}/preview`,
        thumbnail: r.thumbnail_path ? `/api/assets/${r.id}/thumbnail` : null,
        download: `/api/assets/${r.id}/file?download=1`,
      },
      createdAt: r.created_at,
    };
  }

  private async hashFile(file: string): Promise<string> {
    const h = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(file), h);
    return h.digest("hex");
  }

  /**
   * Nhận file (đã nằm ở tmpPath) vào kho: kiểm bằng ffprobe (video phải có luồng
   * hình thật), thumbnail, bản xem H.264 nếu cần, ghi DB.
   */
  async ingestFile(args: {
    workspaceId: string;
    sessionId: string | null;
    tmpPath: string;
    fileName: string;
    kind: "reference" | "generated" | "image";
    origin: "upload" | "provider" | "merge";
    createdBy: string | null;
    sourceJobId?: string | null;
    sourceAttempt?: number | null;
    folder: string;
    /** Ảnh: cố tạo thumbnail nhỏ (lỗi thì dùng chính file gốc, không làm hỏng việc lưu) */
    thumbnail?: boolean;
  }): Promise<AssetRow> {
    const id = newId("ast");
    const name = safeName(args.fileName);
    const mime = mimeOf(name) ?? (args.kind === "image" ? "image/jpeg" : "video/mp4");
    const relDir = path.join(args.workspaceId, args.folder, id);
    const absDir = this.abs(relDir);
    fs.mkdirSync(absDir, { recursive: true });
    const relFile = path.join(relDir, name);
    const absFile = this.abs(relFile);
    fs.renameSync(args.tmpPath, absFile);

    let info = null as Awaited<ReturnType<typeof probe>> | null;
    let thumbRel: string | null = null;
    let previewRel: string | null = null;
    try {
      if (args.kind !== "image") {
        info = await probe(this.media, absFile);
        if (!info.hasVideo) throw new AppError("INVALID_VIDEO", "File không có luồng hình (không phải video hợp lệ).", 400);
        thumbRel = path.join(relDir, "thumb.jpg");
        await makeThumbnail(this.media, absFile, this.abs(thumbRel), info.durationSec);
        if (needsPreview(info)) {
          previewRel = path.join(relDir, "preview.mp4");
          await makePreview(this.media, absFile, this.abs(previewRel));
        }
      } else {
        thumbRel = relFile;
        if (args.thumbnail) {
          try {
            const tRel = path.join(relDir, "thumb.jpg");
            await makeImageThumbnail(this.media, absFile, this.abs(tRel));
            thumbRel = tRel;
          } catch {
            thumbRel = relFile;
          }
          try {
            const pi = await probe(this.media, absFile);
            info = { ...pi, durationSec: null, fps: null, videoCodec: null, hasAudio: false };
          } catch {
            /* không đọc được kích thước thì bỏ qua */
          }
        }
      }
    } catch (e) {
      fs.rmSync(absDir, { recursive: true, force: true });
      if (e instanceof AppError) throw e;
      throw new AppError("INVALID_MEDIA", `Không đọc được file media: ${(e as Error).message}`, 400);
    }

    const size = fs.statSync(absFile).size;
    const sha = await this.hashFile(absFile);
    const row: AssetRow = {
      id,
      workspace_id: args.workspaceId,
      session_id: args.sessionId,
      kind: args.kind,
      origin: args.origin,
      file_name: name,
      storage_path: relFile,
      preview_path: previewRel,
      thumbnail_path: thumbRel,
      mime,
      size_bytes: size,
      sha256: sha,
      duration_sec: info?.durationSec ?? null,
      width: info?.width ?? null,
      height: info?.height ?? null,
      fps: info?.fps ?? null,
      video_codec: info?.videoCodec ?? null,
      has_audio: info ? (info.hasAudio ? 1 : 0) : null,
      source_job_id: args.sourceJobId ?? null,
      source_attempt: args.sourceAttempt ?? null,
      in_library: 0,
      created_by: args.createdBy,
      created_at: nowIso(),
    };
    try {
      this.db.run(
        `INSERT INTO video_assets (id, workspace_id, session_id, kind, origin, file_name, storage_path, preview_path, thumbnail_path, mime, size_bytes, sha256,
          duration_sec, width, height, fps, video_codec, has_audio, source_job_id, source_attempt, in_library, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.workspace_id,
        row.session_id,
        row.kind,
        row.origin,
        row.file_name,
        row.storage_path,
        row.preview_path,
        row.thumbnail_path,
        row.mime,
        row.size_bytes,
        row.sha256,
        row.duration_sec,
        row.width,
        row.height,
        row.fps,
        row.video_codec,
        row.has_audio,
        row.source_job_id,
        row.source_attempt,
        row.in_library,
        row.created_by,
        row.created_at,
      );
    } catch (e) {
      // Trùng (job, attempt): một tiến trình khác đã nhận kết quả này rồi → dùng asset có sẵn
      if (args.sourceJobId && /UNIQUE/i.test((e as Error).message)) {
        fs.rmSync(absDir, { recursive: true, force: true });
        const existing = this.db.get<AssetRow>("SELECT * FROM video_assets WHERE source_job_id = ? AND source_attempt = ?", args.sourceJobId, args.sourceAttempt ?? null);
        if (existing) return existing;
      }
      throw e;
    }
    return row;
  }

  /** Asset đã có cho (job, attempt)? - kiểm trước khi tải để không tải lại */
  existingForJob(jobId: string, attempt: number): AssetRow | undefined {
    return this.db.get<AssetRow>("SELECT * FROM video_assets WHERE source_job_id = ? AND source_attempt = ?", jobId, attempt);
  }

  /**
   * Tải kết quả provider về kho BỀN (signed URL chỉ sống 24h - không bao giờ lưu
   * URL làm tài sản). Chỉ nhận https (hoặc http khi chạy kiểm thử localhost).
   */
  async downloadToTmp(url: string, tmpFile: string, fetchImpl: typeof fetch = fetch): Promise<void> {
    const u = new URL(url);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new ProviderError("DOWNLOAD_FAILED", "URL kết quả không phải https.");
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(10 * 60_000) });
    } catch (e) {
      throw new ProviderError("DOWNLOAD_FAILED", `Tải video thất bại: ${redact((e as Error).message)}`, { transient: true });
    }
    if (!res.ok || !res.body) throw new ProviderError("DOWNLOAD_FAILED", `Tải video thất bại: HTTP ${res.status}`, { transient: res.status >= 500 });
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmpFile));
  }

  setInLibrary(workspaceId: string, ids: string[], value: boolean): number {
    let n = 0;
    for (const id of ids) n += this.db.run("UPDATE video_assets SET in_library = ? WHERE id = ? AND workspace_id = ?", value ? 1 : 0, id, workspaceId).changes;
    return n;
  }

  /**
   * XÓA HẲN asset: file trên đĩa (cả thumbnail/bản xem) + dòng DB.
   * Phân tích của asset bị cascade theo FK; job/phiên bản chỉ mất liên kết output
   * (giữ lịch sử prompt + chi phí để đối soát).
   *
   * Chặn xóa ảnh/video đang được job CHƯA xong dùng làm tham chiếu (tránh làm
   * hỏng job đang chạy). Dọn đĩa trước-sai thì DB vẫn nhất quán: xóa DB trong
   * transaction, chỉ rm file sau khi commit.
   */
  deleteAssets(workspaceId: string, ids: string[], opts: { skipInUse?: boolean } = {}): { deleted: string[]; skipped: { id: string; reason: string }[]; freedBytes: number } {
    const deleted: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    let freedBytes = 0;
    const dirs: string[] = [];

    for (const id of [...new Set(ids)]) {
      const row = this.db.get<AssetRow>("SELECT * FROM video_assets WHERE id = ? AND workspace_id = ?", id, workspaceId);
      if (!row) {
        if (opts.skipInUse) {
          skipped.push({ id, reason: "Không tìm thấy asset." });
          continue;
        }
        throw new AppError("NOT_FOUND", `Không tìm thấy asset ${id}.`, 404);
      }
      const inUse = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM video_batch_jobs
         WHERE workspace_id = ? AND status NOT IN ('completed','failed','cancelled') AND (reference_asset_ids_json LIKE ? OR config_json LIKE ?)`,
        workspaceId,
        `%${row.id}%`,
        `%${row.id}%`,
      );
      if (Number(inUse?.n ?? 0) > 0) {
        const reason = "Đang được job chưa xong dùng làm ảnh/video tham chiếu.";
        if (opts.skipInUse) {
          skipped.push({ id, reason });
          continue;
        }
        throw new AppError("ASSET_IN_USE", `Asset ${id}: ${reason}`, 409);
      }
      this.db.tx(() => {
        this.db.run("UPDATE video_batch_jobs SET output_asset_id = NULL WHERE output_asset_id = ?", row.id);
        this.db.run("UPDATE generation_versions SET asset_id = NULL WHERE asset_id = ?", row.id);
        this.db.run("DELETE FROM video_assets WHERE id = ? AND workspace_id = ?", row.id, workspaceId);
      });
      deleted.push(row.id);
      freedBytes += Number(row.size_bytes ?? 0);
      // Mỗi asset có thư mục riêng (<ws>/<folder>/<assetId>) - xóa cả thumb + preview
      dirs.push(path.dirname(this.abs(row.storage_path)));
    }

    for (const d of dirs) {
      try {
        if (path.basename(d).startsWith("ast_")) fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // File đang bị trình phát giữ: DB đã sạch, lần dọn sau sẽ bỏ thư mục mồ côi
      }
    }
    return { deleted, skipped, freedBytes };
  }

  /** Thư mục asset không còn dòng DB nào (do xóa lỗi dở, hoặc copy tay) */
  pruneOrphanDirs(workspaceId: string): { removedDirs: number; freedBytes: number } {
    const known = new Set(this.db.all<{ storage_path: string }>("SELECT storage_path FROM video_assets WHERE workspace_id = ?", workspaceId).map((r) => path.dirname(this.abs(r.storage_path))));
    let removedDirs = 0;
    let freedBytes = 0;
    const wsRoot = this.abs(workspaceId);
    if (!fs.existsSync(wsRoot)) return { removedDirs, freedBytes };
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (e.name.startsWith("ast_")) {
          if (known.has(full)) continue;
          freedBytes += dirSize(full);
          fs.rmSync(full, { recursive: true, force: true });
          removedDirs++;
        } else walk(full);
      }
    };
    walk(wsRoot);
    return { removedDirs, freedBytes };
  }
}

function dirSize(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) n += dirSize(full);
    else
      try {
        n += fs.statSync(full).size;
      } catch {
        /* file vừa biến mất */
      }
  }
  return n;
}
