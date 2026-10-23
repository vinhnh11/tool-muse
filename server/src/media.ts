import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Lớp FFmpeg/FFprobe (Render Engine trên máy - không phải AI). Luôn spawn bằng
 * argv array, không qua shell.
 */
export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

export interface ProbeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  pixFmt: string | null;
  hasAudio: boolean;
  hasVideo: boolean;
  formatName: string | null;
}

export function run(file: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(new Error(err.code === "ENOENT" ? `Không tìm thấy ${path.basename(file)} - cài FFmpeg và thêm vào PATH (hoặc đặt FFMPEG_PATH/FFPROBE_PATH).` : err.message));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(file)} thoát mã ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`));
    });
  });
}

function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const [a, b] = r.split("/").map(Number);
  if (!a) return null;
  return b ? a / b : a;
}

export async function probe(tools: MediaTools, file: string): Promise<ProbeResult> {
  const { stdout } = await run(tools.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000 });
  const j = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: Record<string, string | number>[] };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const dur = Number(j.format?.duration ?? (v?.duration as string) ?? NaN);
  return {
    durationSec: Number.isFinite(dur) ? dur : null,
    width: v ? Number(v.width) || null : null,
    height: v ? Number(v.height) || null : null,
    fps: v ? parseRate(String(v.avg_frame_rate ?? v.r_frame_rate ?? "")) : null,
    videoCodec: v ? String(v.codec_name ?? "") || null : null,
    pixFmt: v ? String(v.pix_fmt ?? "") || null : null,
    hasAudio: Boolean(a),
    hasVideo: Boolean(v),
    formatName: j.format?.format_name ?? null,
  };
}

/** Ảnh thumbnail JPEG (khung ở ~10% thời lượng, tối đa giây thứ 1) */
export async function makeThumbnail(tools: MediaTools, input: string, output: string, durationSec: number | null): Promise<void> {
  const t = Math.min(1, Math.max(0, (durationSec ?? 0) * 0.1));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(tools.ffmpeg, ["-y", "-v", "error", "-ss", t.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", "-q:v", "4", output], { timeoutMs: 60_000 });
}

/** Thumbnail JPEG cho ảnh (cạnh dài tối đa 480px) */
export async function makeImageThumbnail(tools: MediaTools, input: string, output: string): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(tools.ffmpeg, ["-y", "-v", "error", "-i", input, "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),min(480,iw),-2)':'if(gt(iw,ih),-2,min(480,ih))'", "-q:v", "4", output], { timeoutMs: 60_000 });
}

/**
 * Trình duyệt không phát được HEVC 10-bit (Seedance 2.5 1080p trả H.265 10-bit).
 * Giữ nguyên file gốc làm tài sản, tạo thêm bản xem H.264 8-bit để phát/so sánh.
 */
export function needsPreview(p: ProbeResult): boolean {
  if (!p.hasVideo) return false;
  const codecOk = p.videoCodec === "h264" || p.videoCodec === "vp9" || p.videoCodec === "av1";
  const pixOk = !p.pixFmt || p.pixFmt === "yuv420p" || p.pixFmt === "yuvj420p";
  return !(codecOk && pixOk);
}

export async function makePreview(tools: MediaTools, input: string, output: string): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run(
    tools.ffmpeg,
    ["-y", "-v", "error", "-i", input, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-vf", "scale='min(1280,iw)':-2", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output],
    { timeoutMs: 15 * 60_000 },
  );
}

/** Trích một khung JPEG tại thời điểm t (giây), cạnh dài tối đa maxSide */
export async function extractFrame(tools: MediaTools, input: string, t: number, output: string, maxSide = 512): Promise<void> {
  await run(
    tools.ffmpeg,
    ["-y", "-v", "error", "-ss", t.toFixed(3), "-i", input, "-frames:v", "1", "-vf", `scale='if(gt(iw,ih),min(${maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${maxSide},ih))'`, "-q:v", "5", output],
    { timeoutMs: 60_000 },
  );
}

/** Mốc chuyển cảnh thật (scdet). Trả mảng giây. */
export async function detectSceneCuts(tools: MediaTools, input: string, threshold = 10): Promise<number[]> {
  const { stderr } = await run(tools.ffmpeg, ["-hide_banner", "-v", "info", "-i", input, "-vf", `scale=320:-2,scdet=threshold=${threshold}`, "-an", "-f", "null", "-"], { timeoutMs: 10 * 60_000 });
  const out: number[] = [];
  for (const m of stderr.matchAll(/lavfi\.scd\.time:\s*([0-9.]+)/g)) out.push(Number(m[1]));
  return out.filter((n) => Number.isFinite(n));
}

/** Khoảng lặng (silencedetect) + độ to tích hợp (ebur128) */
export async function measureAudio(tools: MediaTools, input: string): Promise<{ silences: { start: number; end: number }[]; integratedLufs: number | null }> {
  const { stderr } = await run(tools.ffmpeg, ["-hide_banner", "-v", "info", "-i", input, "-vn", "-af", "silencedetect=noise=-35dB:d=0.4,ebur128", "-f", "null", "-"], { timeoutMs: 10 * 60_000 });
  const silences: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*([0-9.]+)/);
    if (s) start = Number(s[1]);
    const e = line.match(/silence_end:\s*([0-9.]+)/);
    if (e && start !== null) {
      silences.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  const lufsAll = [...stderr.matchAll(/I:\s*(-?[0-9.]+)\s*LUFS/g)];
  const last = lufsAll[lufsAll.length - 1];
  return { silences, integratedLufs: last ? Number(last[1]) : null };
}

/** Tách tiếng mono 16kHz WAV thành các khúc chunkSec giây */
export async function extractAudioChunks(tools: MediaTools, input: string, outDir: string, durationSec: number, chunkSec = 240): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (let t = 0, i = 0; t < durationSec; t += chunkSec, i++) {
    const out = path.join(outDir, `audio-${String(i).padStart(3, "0")}.wav`);
    await run(tools.ffmpeg, ["-y", "-v", "error", "-ss", String(t), "-t", String(chunkSec), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], { timeoutMs: 5 * 60_000 });
    files.push(out);
  }
  return files;
}

/**
 * Video THẬT cho Mock provider (testsrc2 + chữ), để kiểm luồng xem/tải/so sánh
 * mà không tốn tiền. Độ phân giải thấp để nhanh. Không phải video AI.
 */
export async function renderMockVideo(tools: MediaTools, output: string, opts: { durationSec: number; aspect: string; label: string; withAudio: boolean }): Promise<void> {
  const size = opts.aspect === "16:9" ? "640x360" : opts.aspect === "1:1" ? "480x480" : opts.aspect === "4:3" ? "480x360" : opts.aspect === "3:4" ? "360x480" : opts.aspect === "21:9" ? "672x288" : "360x640";
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const textFile = output + ".txt";
  fs.writeFileSync(textFile, `MOCK - KHONG PHAI VIDEO AI\n${opts.label.replace(/[^\x20-\x7E]/g, "?").slice(0, 60)}`);
  const fontArg = fontFileArg();
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=12:duration=${opts.durationSec}`];
  if (opts.withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${opts.durationSec}`);
  const tf = textFile.replace(/\\/g, "/").replace(/:/g, "\\:");
  args.push("-vf", `drawtext=${fontArg}textfile='${tf}':fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6:x=10:y=10`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (opts.withAudio) args.push("-c:a", "aac", "-shortest");
  args.push("-movflags", "+faststart", output);
  try {
    await run(tools.ffmpeg, args, { timeoutMs: 120_000 });
  } finally {
    fs.rmSync(textFile, { force: true });
  }
}

function fontFileArg(): string {
  const candidates = ["C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Helvetica.ttc"];
  for (const c of candidates) if (fs.existsSync(c)) return `fontfile='${c.replace(/:/g, "\\:")}':`;
  return "";
}
