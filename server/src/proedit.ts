import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "./context.ts";
import { audit } from "./events.ts";
import type { AssetRow } from "./storage.ts";
import { AppError, newId } from "./util.ts";

/**
 * Dựng nâng cao bằng Claude Code CLI (`claude -p`) + skill HyperFrames/Remotion có sẵn trên máy:
 * tiêu đề động, caption, chuyển cảnh, nhạc... Chạy nền vài phút/lần, nên trả jobId ngay rồi hỏi trạng thái sau.
 * Lưu ý: dùng quota gói Claude của máy, KHÔNG đi qua 9Router/vinh1.
 */
export interface ProEditJob {
  id: string;
  workspaceId: string;
  status: "running" | "done" | "failed";
  message: string;
  clipCount: number;
  startedAt: string;
  finishedAt: string | null;
  assetId: string | null;
  error: string | null;
}

const JOBS = new Map<string, ProEditJob>();
const WORK_ROOT = process.env.BVS_PROEDIT_DIR || "D:/Hermes_Work/bvs/pro-edit";
const CLAUDE = process.env.CLAUDE_PATH || "claude";
const TIMEOUT_MS = 30 * 60_000;

export function getProEdit(workspaceId: string, id: string): ProEditJob {
  const j = JOBS.get(id);
  if (!j || j.workspaceId !== workspaceId) throw new AppError("NOT_FOUND", "Không tìm thấy lượt dựng này (có thể BVS đã khởi động lại).", 404);
  return j;
}

export function listProEdits(workspaceId: string): ProEditJob[] {
  return [...JOBS.values()].filter((j) => j.workspaceId === workspaceId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function startProEdit(
  ctx: AppContext,
  args: { workspaceId: string; userId: string | null; actor: string; assetIds: string[]; brief?: string; name?: string; sessionId?: string | null },
): ProEditJob {
  if (args.assetIds.length < 2) throw new AppError("NEED_2_VIDEOS", "Cần chọn ít nhất 2 video.", 400);
  if ([...JOBS.values()].some((j) => j.status === "running" && j.workspaceId === args.workspaceId))
    throw new AppError("PROEDIT_BUSY", "Đang có một lượt dựng nâng cao chạy - đợi xong rồi dựng tiếp.", 409);
  const rows = args.assetIds.map((id) => ctx.storage.getRow(args.workspaceId, id));
  for (const r of rows) if (r.kind === "image") throw new AppError("NOT_VIDEO", `${r.file_name} là ảnh.`, 400);

  const id = newId("pe");
  const dir = path.join(WORK_ROOT, id);
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  const clipLines: string[] = [];
  rows.forEach((r, i) => {
    const n = `clip${i + 1}.mp4`;
    fs.copyFileSync(ctx.storage.abs(r.storage_path), path.join(dir, n));
    const j = ctx.db.get<{ prompt: string | null }>("SELECT prompt FROM video_batch_jobs WHERE id = ?", r.source_job_id ?? "");
    clipLines.push(`- ${n} (${Math.round(r.duration_sec ?? 0)}s, ${r.width}x${r.height})${j?.prompt ? `: ${j.prompt.slice(0, 300)}` : ""}`);
  });
  const W = rows[0]!.width ?? 720;
  const H = rows[0]!.height ?? 1280;
  const prompt = [
    `Dùng skill hyperframes (nếu không chạy được thì dùng remotion) để dựng 1 video hoàn chỉnh ${W}x${H} từ ${rows.length} clip trong thư mục hiện tại, theo ĐÚNG thứ tự:`,
    ...clipLines,
    `Yêu cầu của người dùng: ${args.brief?.trim() || "video quảng cáo nhịp nhanh, chuyển cảnh mượt, tiêu đề mở đầu ngắn dạng chữ động, caption tiếng Việt ngắn dưới mỗi clip."}`,
    "Quy tắc: giữ tiếng gốc của clip; chữ tiếng Việt phải đủ dấu (dùng font có hỗ trợ tiếng Việt, ví dụ Montserrat/Be Vietnam Pro bản Vietnamese); caption đặt sát đáy, không đè chữ có sẵn trong clip; cỡ chữ đủ lớn đọc được trên điện thoại.",
    "Tự kiểm tra (hyperframes check/snapshot) trước khi render. Xuất ĐÚNG file out/result.mp4. Chỉ làm trong thư mục này, không hỏi lại. Cuối cùng in 1 dòng tóm tắt: công cụ đã dùng.",
  ].join("\n");

  const job: ProEditJob = { id, workspaceId: args.workspaceId, status: "running", message: "Claude Code đang dựng (thường 5-10 phút)...", clipCount: rows.length, startedAt: new Date().toISOString(), finishedAt: null, assetId: null, error: null };
  JOBS.set(id, job);
  audit(ctx.db, { workspaceId: args.workspaceId, userId: args.userId ?? undefined, actor: args.actor, action: "asset.pro_edit_start", targetType: "pro_edit", targetId: id, data: { sources: args.assetIds } });

  const fail = (msg: string) => {
    job.status = "failed";
    job.error = msg;
    job.message = msg;
    job.finishedAt = new Date().toISOString();
  };
  let tail = "";
  const child = spawn(
    CLAUDE,
    ["-p", prompt, "--permission-mode", "acceptEdits", "--allowed-tools", "Bash,Read,Write,Edit,Skill,Glob,Grep", "--max-turns", "60", "--output-format", "text"],
    { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  child.stdout.on("data", (c: Buffer) => (tail = (tail + c.toString("utf8")).slice(-3000)));
  child.stderr.on("data", (c: Buffer) => (tail = (tail + c.toString("utf8")).slice(-3000)));
  child.on("error", (e: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    fail(e.code === "ENOENT" ? "Không tìm thấy Claude Code CLI (đặt CLAUDE_PATH)." : e.message);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    void (async () => {
      const result = path.join(dir, "out", "result.mp4");
      if (!fs.existsSync(result)) return fail(`Claude Code kết thúc (mã ${code}) nhưng không tạo ra out/result.mp4. ${tail.slice(-300)}`);
      try {
        const tmp = ctx.storage.tmpDir("proedit-" + id);
        const tmpFile = path.join(tmp, "result.mp4");
        fs.copyFileSync(result, tmpFile);
        const base = (args.name?.trim() || `dung-nang-cao-${rows.length}-clip`).replace(/\.mp4$/i, "");
        const asset: AssetRow = await ctx.storage.ingestFile({ workspaceId: args.workspaceId, sessionId: args.sessionId ?? rows[0]!.session_id, tmpPath: tmpFile, fileName: `${base}.mp4`, kind: "generated", origin: "merge", createdBy: args.userId, folder: "merged" });
        fs.rmSync(tmp, { recursive: true, force: true });
        ctx.storage.setInLibrary(args.workspaceId, [asset.id], true);
        audit(ctx.db, { workspaceId: args.workspaceId, userId: args.userId ?? undefined, actor: args.actor, action: "asset.pro_edit", targetType: "asset", targetId: asset.id, data: { sources: args.assetIds, job: id } });
        job.status = "done";
        job.assetId = asset.id;
        job.message = `Đã dựng xong (${Math.round(asset.duration_sec ?? 0)}s), đã thêm vào Thư viện.`;
        job.finishedAt = new Date().toISOString();
      } catch (e) {
        fail(`Dựng xong nhưng không nhập được vào kho: ${(e as Error).message}`);
      }
    })();
  });
  return job;
}
