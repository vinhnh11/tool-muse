import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "./context.ts";
import { audit } from "./events.ts";
import { probe, run } from "./media.ts";
import type { AssetRow } from "./storage.ts";
import { AppError, newId } from "./util.ts";

/**
 * Ghép nhiều video thành 1 (FFmpeg trên máy, không tốn quota Muse/provider).
 * Thứ tự = thứ tự assetIds. Mọi clip được chuẩn hóa về cùng khung hình/fps của clip đầu
 * (scale + pad, không méo) rồi nối bằng concat filter; clip thiếu âm thanh được chèn im lặng.
 */
export async function mergeVideos(
  ctx: AppContext,
  args: { workspaceId: string; userId: string | null; actor: string; sessionId?: string | null; assetIds: string[]; name?: string },
): Promise<AssetRow> {
  const ids = args.assetIds;
  if (ids.length < 2) throw new AppError("NEED_2_VIDEOS", "Cần chọn ít nhất 2 video để ghép.", 400);
  const rows = ids.map((id) => ctx.storage.getRow(args.workspaceId, id));
  for (const r of rows) if (r.kind === "image") throw new AppError("NOT_VIDEO", `${r.file_name} là ảnh, không ghép được.`, 400);

  const files = rows.map((r) => ctx.storage.abs(r.storage_path));
  for (const f of files) if (!fs.existsSync(f)) throw new AppError("NOT_FOUND", `File đã mất khỏi kho: ${path.basename(f)}`, 404);
  const infos = await Promise.all(files.map((f) => probe(ctx.media, f)));
  const W = (infos[0]!.width ?? 720) & ~1;
  const H = (infos[0]!.height ?? 1280) & ~1;
  const FPS = Math.round(infos[0]!.fps ?? 30) || 30;
  const anyAudio = infos.some((i) => i.hasAudio);

  const tmp = ctx.storage.tmpDir("merge-" + newId("m"));
  const out = path.join(tmp, "merged.mp4");
  const argv: string[] = ["-y", "-v", "error"];
  for (const f of files) argv.push("-i", f);
  const silenceIdx: Record<number, number> = {};
  if (anyAudio) {
    let n = files.length;
    infos.forEach((info, i) => {
      if (!info.hasAudio) {
        argv.push("-f", "lavfi", "-t", String(info.durationSec ?? 5), "-i", "anullsrc=r=44100:cl=stereo");
        silenceIdx[i] = n++;
      }
    });
  }
  const parts: string[] = [];
  let concatIn = "";
  files.forEach((_, i) => {
    parts.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
    concatIn += `[v${i}]`;
    if (anyAudio) {
      const src = infos[i]!.hasAudio ? `${i}:a` : `${silenceIdx[i]}:a`;
      parts.push(`[${src}]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      concatIn += `[a${i}]`;
    }
  });
  parts.push(`${concatIn}concat=n=${files.length}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? "[a]" : ""}`);
  argv.push("-filter_complex", parts.join(";"), "-map", "[v]");
  if (anyAudio) argv.push("-map", "[a]", "-c:a", "aac", "-b:a", "128k");
  argv.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", out);
  try {
    await run(ctx.media.ffmpeg, argv, { timeoutMs: 30 * 60_000 });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new AppError("MERGE_FAILED", `Ghép video thất bại: ${(e as Error).message}`, 500);
  }

  const base = (args.name?.trim() || `ghep-${ids.length}-video-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`).replace(/\.mp4$/i, "");
  const row = await ctx.storage.ingestFile({
    workspaceId: args.workspaceId,
    sessionId: args.sessionId ?? rows[0]!.session_id,
    tmpPath: out,
    fileName: `${base}.mp4`,
    kind: "generated",
    origin: "merge",
    createdBy: args.userId,
    folder: "merged",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  ctx.storage.setInLibrary(args.workspaceId, [row.id], true);
  audit(ctx.db, { workspaceId: args.workspaceId, userId: args.userId ?? undefined, actor: args.actor, action: "asset.merge", targetType: "asset", targetId: row.id, data: { sources: ids } });
  return row;
}
