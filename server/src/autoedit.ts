import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext } from "./context.ts";
import { audit } from "./events.ts";
import { probe, run } from "./media.ts";
import type { AssetRow } from "./storage.ts";
import { AppError, newId } from "./util.ts";

const TRANSITIONS = ["fade", "wipeleft", "wiperight", "slideleft", "slideright", "circleopen", "dissolve", "fadeblack", "smoothleft", "zoomin"] as const;

const planSchema = z.object({
  title: z.string().optional().default(""),
  transition: z.string().optional().default("fade"),
  transitionSec: z.number().optional().default(0.5),
  clips: z
    .array(
      z.object({
        id: z.string(),
        start: z.number().optional().default(0),
        end: z.number().nullable().optional().default(null),
        caption: z.string().optional().default(""),
      }),
    )
    .min(1),
});
export type EditPlan = z.infer<typeof planSchema>;

const FONT = "C\\:/Windows/Fonts/arial.ttf";

export async function planEdit(ctx: AppContext, workspaceId: string, rows: AssetRow[], brief: string): Promise<EditPlan> {
  const info = rows.map((r) => {
    const j = ctx.db.get<{ prompt: string | null; title: string | null }>("SELECT prompt, title FROM video_batch_jobs WHERE id = ?", r.source_job_id ?? "");
    return { id: r.id, durationSec: r.duration_sec, title: j?.title ?? r.file_name, prompt: (j?.prompt ?? "").slice(0, 400) };
  });
  const model = ctx.llm.getSettings(workspaceId).textModel;
  const system = [
    "Bạn là editor video. Nhận danh sách clip (id, thời lượng, mô tả) và yêu cầu của người dùng, trả kế hoạch dựng.",
    "Chọn thứ tự clip hợp lý để kể thành 1 video liền mạch (hook mạnh ở đầu, kết có CTA/khoảnh khắc chốt).",
    "Có thể cắt đầu/đuôi clip (start/end tính bằng giây) nếu cần cho nhịp nhanh; end=null là giữ tới hết. Mỗi clip giữ ≥ 2 giây.",
    'caption: chữ ngắn (≤ 8 từ, tiếng Việt có dấu) hiện dưới clip, hoặc "" nếu không cần.',
    `transition chọn 1 trong: ${TRANSITIONS.join(", ")}. transitionSec 0.3–0.8.`,
    'Chỉ dùng id có trong danh sách, không lặp. Trả DUY NHẤT JSON {"title":string,"transition":string,"transitionSec":number,"clips":[{"id":string,"start":number,"end":number|null,"caption":string}]}',
  ].join("\n");
  return ctx.llm.json(workspaceId, {
    model,
    system,
    user: JSON.stringify({ brief: brief || "Ghép thành 1 video quảng cáo hoàn chỉnh, nhịp nhanh.", clips: info }),
    schema: planSchema,
    temperature: 0.5,
    maxTokens: 3000,
  });
}

export async function renderEdit(
  ctx: AppContext,
  args: { workspaceId: string; userId: string | null; actor: string; assetIds: string[]; brief?: string; name?: string; plan?: EditPlan; sessionId?: string | null },
): Promise<{ asset: AssetRow; plan: EditPlan }> {
  if (args.assetIds.length < 2) throw new AppError("NEED_2_VIDEOS", "Cần chọn ít nhất 2 video.", 400);
  const rows = args.assetIds.map((id) => ctx.storage.getRow(args.workspaceId, id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const plan = args.plan ?? (await planEdit(ctx, args.workspaceId, rows, args.brief ?? ""));

  // Làm sạch kế hoạch: id hợp lệ, không lặp; clip LLM bỏ sót được thêm vào cuối
  const seen = new Set<string>();
  const clips = plan.clips.filter((c) => byId.has(c.id) && !seen.has(c.id) && seen.add(c.id));
  for (const r of rows) if (!seen.has(r.id)) clips.push({ id: r.id, start: 0, end: null, caption: "" });
  if (clips.length < 2) throw new AppError("BAD_PLAN", "Kế hoạch dựng không hợp lệ.", 502);

  const infos = await Promise.all(clips.map((c) => probe(ctx.media, ctx.storage.abs(byId.get(c.id)!.storage_path))));
  const seg = clips.map((c, i) => {
    const total = infos[i]!.durationSec ?? 5;
    let s = Math.max(0, Math.min(c.start ?? 0, total - 2));
    let e = c.end == null ? total : Math.min(total, c.end);
    if (e - s < 2) {
      s = 0;
      e = total;
    }
    return { s, e, d: e - s };
  });
  const minD = Math.min(...seg.map((x) => x.d));
  const td = Math.max(0.2, Math.min(plan.transitionSec || 0.5, minD / 3, 1));
  const tr = (TRANSITIONS as readonly string[]).includes(plan.transition) ? plan.transition : "fade";
  const W = (infos[0]!.width ?? 720) & ~1;
  const H = (infos[0]!.height ?? 1280) & ~1;
  const FPS = Math.round(infos[0]!.fps ?? 30) || 30;
  const anyAudio = infos.some((i) => i.hasAudio);

  const tmp = ctx.storage.tmpDir("edit-" + newId("e"));
  const argv = ["-y", "-v", "error"];
  clips.forEach((c) => argv.push("-i", ctx.storage.abs(byId.get(c.id)!.storage_path)));
  const f: string[] = [];
  clips.forEach((c, i) => {
    let v = `[${i}:v]trim=start=${seg[i]!.s}:end=${seg[i]!.e},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`;
    const cap = (c.caption ?? "").trim();
    if (cap) {
      fs.writeFileSync(path.join(tmp, `c${i}.txt`), cap, "utf8");
      v += `,drawtext=fontfile='${FONT}':textfile=c${i}.txt:fontsize=${Math.round(H / 24)}:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h*0.8:enable='between(t,0.3,${Math.max(0.5, seg[i]!.d - 0.3).toFixed(2)})'`;
    }
    f.push(`${v}[v${i}]`);
    if (anyAudio)
      f.push(
        infos[i]!.hasAudio
          ? `[${i}:a]atrim=start=${seg[i]!.s}:end=${seg[i]!.e},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo[a${i}]`
          : `anullsrc=r=44100:cl=stereo,atrim=0:${seg[i]!.d},asetpts=PTS-STARTPTS[a${i}]`,
      );
  });
  let cur = "v0";
  let acur = "a0";
  let len = seg[0]!.d;
  for (let i = 1; i < clips.length; i++) {
    const off = (len - td).toFixed(3);
    f.push(`[${cur}][v${i}]xfade=transition=${tr}:duration=${td}:offset=${off}[x${i}]`);
    if (anyAudio) f.push(`[${acur}][a${i}]acrossfade=d=${td}[ax${i}]`);
    cur = `x${i}`;
    acur = `ax${i}`;
    len = len + seg[i]!.d - td;
  }
  argv.push("-filter_complex", f.join(";"), "-map", `[${cur}]`);
  if (anyAudio) argv.push("-map", `[${acur}]`, "-c:a", "aac", "-b:a", "128k");
  argv.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", "out.mp4");
  try {
    await run(ctx.media.ffmpeg, argv, { timeoutMs: 30 * 60_000, cwd: tmp });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new AppError("EDIT_FAILED", `Dựng video thất bại: ${(e as Error).message}`, 500);
  }
  const base = (args.name?.trim() || plan.title?.trim() || `auto-edit-${clips.length}-clip`).replace(/\.mp4$/i, "");
  const asset = await ctx.storage.ingestFile({
    workspaceId: args.workspaceId,
    sessionId: args.sessionId ?? rows[0]!.session_id,
    tmpPath: path.join(tmp, "out.mp4"),
    fileName: `${base}.mp4`,
    kind: "generated",
    origin: "merge",
    createdBy: args.userId,
    folder: "merged",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  ctx.storage.setInLibrary(args.workspaceId, [asset.id], true);
  audit(ctx.db, { workspaceId: args.workspaceId, userId: args.userId ?? undefined, actor: args.actor, action: "asset.auto_edit", targetType: "asset", targetId: asset.id, data: { sources: clips.map((c) => c.id), transition: tr } });
  return { asset, plan: { ...plan, clips } };
}
