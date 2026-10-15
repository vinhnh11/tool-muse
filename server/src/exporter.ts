import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import type { Writable } from "node:stream";
import type { AppContext } from "./context.ts";
import { BatchService, type JobRow } from "./batches.ts";
import type { AssetRow } from "./storage.ts";
import { toCsv, toTxt } from "./prompts.ts";
import { AppError, nowIso } from "./util.ts";
import { audit } from "./events.ts";

/** Xuất batch: ZIP (video + manifest + prompt), CSV/JSON metadata, TXT prompt */
export class ExportService {
  private ctx: AppContext;
  private svc: BatchService;
  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.svc = new BatchService(ctx);
  }

  private jobs(workspaceId: string, batchId: string): JobRow[] {
    this.svc.getBatchRow(workspaceId, batchId);
    return this.ctx.db.all<JobRow>("SELECT * FROM video_batch_jobs WHERE batch_id = ? AND workspace_id = ? ORDER BY seq", batchId, workspaceId);
  }

  metadataRows(workspaceId: string, batchId: string) {
    return this.jobs(workspaceId, batchId).map((j) => {
      const a = j.output_asset_id ? this.ctx.db.get<AssetRow>("SELECT * FROM video_assets WHERE id = ?", j.output_asset_id) : undefined;
      const pub = this.svc.jobToPublic(j);
      return {
        seq: j.seq,
        job_id: j.id,
        version: j.version,
        lineage_id: j.lineage_id,
        status: j.status,
        title: j.title,
        prompt: j.prompt,
        negative: j.negative ?? "",
        model: j.model_id,
        duration_sec: pub.config.durationSec,
        aspect_ratio: pub.config.aspectRatio,
        resolution: pub.config.resolution,
        audio: pub.config.audio,
        attempts: j.attempt,
        remote_job_id: j.remote_job_id ?? "",
        error_code: j.error_code ?? "",
        error_message: j.error_message ?? "",
        estimated_cost: j.estimated_cost ?? "",
        actual_cost: j.actual_cost ?? "",
        file: a ? `videos/${a.file_name}` : "",
        sha256: a?.sha256 ?? "",
        created_at: j.created_at,
        completed_at: j.completed_at ?? "",
      };
    });
  }

  exportText(workspaceId: string, batchId: string, format: "csv" | "json" | "txt"): { body: string; mime: string; fileName: string } {
    const b = this.svc.getBatchRow(workspaceId, batchId);
    const rows = this.metadataRows(workspaceId, batchId);
    const base = safeBase(b.name);
    if (format === "txt") return { body: toTxt(rows.map((r) => r.prompt)), mime: "text/plain; charset=utf-8", fileName: `${base}-prompts.txt` };
    if (format === "csv") return { body: "\uFEFF" + toCsv(rows, Object.keys(rows[0] ?? { seq: 0 })), mime: "text/csv; charset=utf-8", fileName: `${base}-metadata.csv` };
    return { body: JSON.stringify({ batch: this.svc.batchToPublic(b), jobs: rows, exportedAt: nowIso() }, null, 2), mime: "application/json; charset=utf-8", fileName: `${base}-metadata.json` };
  }

  /** ZIP stream: chỉ video ĐÃ hoàn thành + manifest.json + prompts.csv/txt */
  async zipBatch(workspaceId: string, batchId: string, out: Writable, actor: { userId: string | null; kind: string }): Promise<{ fileName: string; videos: number }> {
    const b = this.svc.getBatchRow(workspaceId, batchId);
    const rows = this.metadataRows(workspaceId, batchId);
    const done = this.jobs(workspaceId, batchId).filter((j) => j.status === "completed" && j.output_asset_id);
    const zip = archiver("zip", { zlib: { level: 1 } });
    const finished = new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      out.on("close", () => resolve());
      out.on("finish", () => resolve());
    });
    zip.pipe(out);
    let n = 0;
    for (const j of done) {
      const a = this.ctx.db.get<AssetRow>("SELECT * FROM video_assets WHERE id = ? AND workspace_id = ?", j.output_asset_id, workspaceId);
      if (!a) continue;
      const file = this.ctx.storage.abs(a.storage_path);
      if (!fs.existsSync(file)) continue;
      zip.file(file, { name: `videos/${a.file_name}`, store: true } as archiver.EntryData);
      n++;
    }
    zip.append(JSON.stringify({ batch: this.svc.batchToPublic(b), jobs: rows, exportedAt: nowIso() }, null, 2), { name: "manifest.json" });
    zip.append("\uFEFF" + toCsv(rows, Object.keys(rows[0] ?? { seq: 0 })), { name: "prompts.csv" });
    zip.append(toTxt(rows.map((r) => r.prompt)), { name: "prompts.txt" });
    await zip.finalize();
    await finished;
    audit(this.ctx.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "batch.export_zip", targetType: "batch", targetId: batchId, data: { videos: n } });
    return { fileName: `${safeBase(b.name)}.zip`, videos: n };
  }

  /** ZIP các asset bất kỳ (tải nhiều video từ Thư viện) */
  async zipAssets(workspaceId: string, assetIds: string[], out: Writable): Promise<number> {
    const zip = archiver("zip", { zlib: { level: 1 } });
    const finished = new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      out.on("close", () => resolve());
      out.on("finish", () => resolve());
    });
    zip.pipe(out);
    let n = 0;
    const used = new Set<string>();
    for (const id of new Set(assetIds)) {
      const a = this.ctx.storage.getRow(workspaceId, id);
      if (!fs.existsSync(this.ctx.storage.abs(a.storage_path))) continue;
      let name = a.file_name;
      if (used.has(name)) name = `${a.id}-${name}`;
      used.add(name);
      zip.file(this.ctx.storage.abs(a.storage_path), { name, store: true } as archiver.EntryData);
      n++;
    }
    await zip.finalize();
    await finished;
    return n;
  }

  /** Đưa video sang workflow chỉnh sửa: chép vào EDIT_INBOX_DIR + file mô tả đi kèm */
  sendToEdit(workspaceId: string, assetId: string): { path: string } {
    const dir = this.ctx.cfg.editInboxDir;
    if (!dir) throw new AppError("EDIT_INBOX_NOT_CONFIGURED", "Chưa cấu hình EDIT_INBOX_DIR (thư mục nhận video của công cụ chỉnh sửa) trong .env.", 409);
    const a = this.ctx.storage.getRow(workspaceId, assetId);
    const job = a.source_job_id ? this.ctx.db.get<JobRow>("SELECT * FROM video_batch_jobs WHERE id = ?", a.source_job_id) : undefined;
    const target = path.join(dir, job ? safeBase(job.batch_id) : "batch-studio");
    fs.mkdirSync(target, { recursive: true });
    let dest = path.join(target, a.file_name);
    if (fs.existsSync(dest)) dest = path.join(target, `${path.parse(a.file_name).name}-${Date.now()}${path.extname(a.file_name)}`);
    fs.copyFileSync(this.ctx.storage.abs(a.storage_path), dest);
    fs.writeFileSync(dest + ".json", JSON.stringify({ assetId: a.id, sha256: a.sha256, prompt: job?.prompt ?? null, model: job?.model_id ?? null, version: job?.version ?? null, exportedAt: nowIso() }, null, 2));
    return { path: dest };
  }
}

function safeBase(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "batch";
}
