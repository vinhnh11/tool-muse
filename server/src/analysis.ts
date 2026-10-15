import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext } from "./context.ts";
import { audit, recordEvent } from "./events.ts";
import type { ChatContentPart } from "./llm.ts";
import { detectSceneCuts, extractAudioChunks, extractFrame, measureAudio, probe } from "./media.ts";
import type { Actor } from "./batches.ts";
import { AppError, newId, nowIso, redact, safeJsonParse } from "./util.ts";

/**
 * PHÂN TÍCH VIDEO THAM KHẢO - xem THẬT nội dung, không đoán từ tên file:
 *  1. ffprobe + đo đạc tất định (FFmpeg, không phải AI): mốc chuyển cảnh thật
 *     (scdet), khoảng lặng, độ to LUFS.
 *  2. Lấy mẫu khung hình phủ TOÀN BỘ thời lượng: dày ở 3 giây đầu (hook) + đều
 *     theo đoạn + tại từng mốc chuyển cảnh → gửi model xem hình theo từng đoạn.
 *  3. Âm thanh: tách WAV theo khúc 4 phút gửi model nghe được (input_audio).
 *     Chưa cấu hình model nghe → ghi rõ "chưa phân tích âm thanh", không bịa.
 *  4. Tổng hợp bằng model chữ thành dữ liệu có cấu trúc + coverage trung thực.
 * Tên file KHÔNG bao giờ được gửi cho model.
 */

const SEGMENT_SEC_DEFAULT = 20;
const MAX_SEGMENTS = 30;
const MAX_FRAMES_PER_SEGMENT = 14;

const segmentSchema = z.object({
  summary: z.string(),
  subjects: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  camera: z.array(z.string()).default([]),
  composition: z.string().default(""),
  lighting_color: z.string().default(""),
  on_screen_text: z.array(z.string()).default([]),
  transitions: z.array(z.string()).default([]),
  moments: z.array(z.object({ t: z.number(), description: z.string() })).default([]),
});
type SegmentResult = z.infer<typeof segmentSchema>;

const audioSchema = z.object({
  speech_present: z.boolean(),
  language: z.string().default(""),
  transcript: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).default([]),
  voice_tone: z.string().default(""),
  music: z.string().default(""),
  sound_effects: z.array(z.string()).default([]),
});
type AudioResult = z.infer<typeof audioSchema>;

export const analysisResultSchema = z.object({
  content: z.object({
    summary: z.string(),
    subjects: z.array(z.string()).default([]),
    storyline: z.array(z.object({ start: z.number(), end: z.number(), description: z.string() })).default([]),
  }),
  hook: z.object({ first_seconds: z.string(), technique: z.string(), why_it_works: z.string() }),
  visual_style: z.object({ look: z.string(), lighting: z.string(), color_palette: z.array(z.string()).default([]), texture: z.string().default("") }),
  camera: z.object({ movements: z.array(z.string()).default([]), shot_sizes: z.array(z.string()).default([]), angles: z.array(z.string()).default([]) }),
  composition_transitions: z.object({ composition: z.string(), transitions: z.array(z.string()).default([]) }),
  pacing_storytelling: z.object({ structure: z.string(), rhythm: z.string() }),
  audio: z.object({ dialogue_summary: z.string().default(""), music: z.string().default(""), sound_effects: z.array(z.string()).default([]), voice: z.string().default("") }),
  reusable_traits: z.array(z.string()).default([]),
  generation_hints: z.object({ genre: z.string().default(""), prompt_elements: z.array(z.string()).default([]), avoid: z.array(z.string()).default([]) }),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export interface Coverage {
  durationSec: number;
  segments: number;
  segmentSec: number;
  framesAnalyzed: number;
  hookFrames: number;
  frameTimes: number[];
  sceneCutsDetected: number;
  wholeVideoCovered: boolean;
  audio: "analyzed" | "not_configured" | "no_audio_track" | "failed";
  audioChunks: number;
  audioError?: string;
  notes: string[];
}

interface AnalysisRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  asset_id: string;
  status: string;
  progress: number;
  step: string | null;
  models_json: string;
  coverage_json: string;
  measurements_json: string;
  result_json: string | null;
  error: string | null;
  lease_owner: string | null;
  lease_until: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function analysisToPublic(r: AnalysisRow) {
  return {
    id: r.id,
    sessionId: r.session_id,
    assetId: r.asset_id,
    status: r.status,
    progress: r.progress,
    step: r.step,
    models: safeJsonParse(r.models_json, {}),
    coverage: safeJsonParse<Coverage | Record<string, never>>(r.coverage_json, {}),
    measurements: safeJsonParse(r.measurements_json, {}),
    result: safeJsonParse<AnalysisResult | null>(r.result_json, null),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class AnalysisService {
  private ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** Xếp hàng phân tích (bền - F5/restart không mất). Đã có bản hoàn thành cùng nội dung + model → dùng lại. */
  request(workspaceId: string, actor: Actor, assetId: string, sessionId: string | null, opts: { force?: boolean } = {}) {
    const asset = this.ctx.storage.getRow(workspaceId, assetId);
    if (asset.kind === "image") throw new AppError("NOT_A_VIDEO", "Chỉ phân tích được video.", 400);
    // kiểm cấu hình trước - báo lỗi ngay thay vì xếp hàng rồi hỏng
    this.ctx.llm.model(workspaceId, "vision");
    this.ctx.llm.model(workspaceId, "text");
    if (!opts.force) {
      const existing = this.ctx.db.get<AnalysisRow>(
        `SELECT a.* FROM video_analyses a JOIN video_assets v ON v.id = a.asset_id
         WHERE a.workspace_id = ? AND v.sha256 = ? AND a.status IN ('queued','running','completed') ORDER BY a.created_at DESC LIMIT 1`,
        workspaceId,
        asset.sha256,
      );
      if (existing && (existing.status !== "completed" || this.sameModels(workspaceId, existing))) return analysisToPublic(existing);
    }
    const id = newId("ana");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO video_analyses (id, workspace_id, session_id, asset_id, status, progress, step, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, 'Chờ phân tích', ?, ?, ?)`,
      id,
      workspaceId,
      sessionId,
      assetId,
      actor.userId,
      now,
      now,
    );
    recordEvent(this.ctx.db, { workspaceId, type: "analysis.status", to: "queued", data: { analysisId: id, assetId } });
    audit(this.ctx.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "analysis.request", targetType: "asset", targetId: assetId });
    return analysisToPublic(this.get(workspaceId, id));
  }

  private sameModels(workspaceId: string, r: AnalysisRow): boolean {
    const s = this.ctx.llm.getSettings(workspaceId);
    const m = safeJsonParse<{ vision?: string; text?: string; audio?: string }>(r.models_json, {});
    return m.vision === s.visionModel && m.text === s.textModel && (m.audio ?? "") === (s.audioModel ?? "");
  }

  get(workspaceId: string, id: string): AnalysisRow {
    const r = this.ctx.db.get<AnalysisRow>("SELECT * FROM video_analyses WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!r) throw new AppError("NOT_FOUND", "Không tìm thấy bản phân tích.", 404);
    return r;
  }

  list(workspaceId: string, opts: { sessionId?: string | null; assetId?: string } = {}) {
    const where = ["workspace_id = ?"];
    const p: string[] = [workspaceId];
    if (opts.sessionId) {
      where.push("session_id = ?");
      p.push(opts.sessionId);
    }
    if (opts.assetId) {
      where.push("asset_id = ?");
      p.push(opts.assetId);
    }
    return this.ctx.db.all<AnalysisRow>(`SELECT * FROM video_analyses WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 200`, ...p).map(analysisToPublic);
  }

  /** Worker nhận một bản phân tích đang chờ (lease) */
  claim(workerId: string, leaseMs = 15 * 60_000, maxRunning = 2): AnalysisRow | null {
    const db = this.ctx.db;
    const now = Date.now();
    return db.tx(() => {
      db.run("UPDATE video_analyses SET status = 'queued', lease_owner = NULL, lease_until = NULL WHERE status = 'running' AND lease_until < ?", now);
      const running = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_analyses WHERE status = 'running'")?.n ?? 0);
      if (running >= maxRunning) return null;
      const r = db.get<AnalysisRow>("SELECT * FROM video_analyses WHERE status = 'queued' ORDER BY created_at LIMIT 1");
      if (!r) return null;
      const ok = db.run("UPDATE video_analyses SET status = 'running', lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'queued'", workerId, now + leaseMs, nowIso(), r.id).changes;
      return ok ? { ...r, status: "running" } : null;
    });
  }

  private progress(r: AnalysisRow, pct: number, step: string): void {
    this.ctx.db.run("UPDATE video_analyses SET progress = ?, step = ?, updated_at = ? WHERE id = ?", Math.round(pct), step, nowIso(), r.id);
    recordEvent(this.ctx.db, { workspaceId: r.workspace_id, type: "analysis.progress", message: step, data: { analysisId: r.id, progress: Math.round(pct) } });
  }

  async run(r: AnalysisRow): Promise<void> {
    const ws = r.workspace_id;
    const work = this.ctx.storage.tmpDir("analysis", r.id);
    try {
      const asset = this.ctx.storage.getRow(ws, r.asset_id);
      const file = this.ctx.storage.abs(asset.storage_path);
      const models = { vision: this.ctx.llm.model(ws, "vision"), text: this.ctx.llm.model(ws, "text"), audio: this.ctx.llm.model(ws, "audio") };
      this.ctx.db.run("UPDATE video_analyses SET models_json = ? WHERE id = ?", JSON.stringify(models), r.id);

      this.progress(r, 3, "Đọc thông số video (ffprobe)");
      const info = await probe(this.ctx.media, file);
      const duration = info.durationSec ?? 0;
      if (!info.hasVideo || duration <= 0) throw new AppError("INVALID_VIDEO", "Video không có luồng hình hoặc thời lượng 0.", 400);

      this.progress(r, 8, "Đo mốc chuyển cảnh (FFmpeg scdet)");
      const cuts = await detectSceneCuts(this.ctx.media, file);
      const audioMeasure = info.hasAudio ? await measureAudio(this.ctx.media, file).catch(() => null) : null;
      const shotLens: number[] = [];
      let prev = 0;
      for (const c of [...cuts, duration]) {
        if (c - prev > 0.05) shotLens.push(c - prev);
        prev = c;
      }
      const measurements = {
        durationSec: Math.round(duration * 100) / 100,
        width: info.width,
        height: info.height,
        fps: info.fps,
        hasAudio: info.hasAudio,
        sceneCuts: cuts.map((c) => Math.round(c * 100) / 100),
        shotCount: shotLens.length,
        avgShotSec: shotLens.length ? Math.round((shotLens.reduce((s, x) => s + x, 0) / shotLens.length) * 100) / 100 : null,
        cutsPerMinute: duration > 0 ? Math.round((cuts.length / duration) * 60 * 10) / 10 : 0,
        silenceRatio: audioMeasure && duration > 0 ? Math.round((audioMeasure.silences.reduce((s, x) => s + (x.end - x.start), 0) / duration) * 100) / 100 : null,
        integratedLufs: audioMeasure?.integratedLufs ?? null,
      };
      this.ctx.db.run("UPDATE video_analyses SET measurements_json = ? WHERE id = ?", JSON.stringify(measurements), r.id);

      // ---- kế hoạch khung hình: phủ toàn bộ video
      let segSec = SEGMENT_SEC_DEFAULT;
      if (duration / segSec > MAX_SEGMENTS) segSec = Math.ceil(duration / MAX_SEGMENTS);
      const segments: { start: number; end: number; times: number[] }[] = [];
      for (let s = 0; s < duration; s += segSec) {
        const e = Math.min(duration, s + segSec);
        const times = new Set<number>();
        if (s === 0) for (const t of [0, 0.5, 1, 1.5, 2, 2.5, 3]) if (t < e) times.add(t);
        const len = e - s;
        const step = Math.max(1, len / 8);
        for (let t = s + step / 2; t < e; t += step) times.add(Math.round(t * 10) / 10);
        for (const c of cuts) if (c >= s && c < e) times.add(Math.round(Math.min(e - 0.05, c + 0.25) * 10) / 10);
        const sorted = [...times].filter((t) => t >= 0 && t < duration).sort((a, b) => a - b);
        // tỉa đều nếu quá nhiều, luôn giữ khung hook
        let picked = sorted;
        if (sorted.length > MAX_FRAMES_PER_SEGMENT) {
          const hook = sorted.filter((t) => s === 0 && t <= 3);
          const rest = sorted.filter((t) => !(s === 0 && t <= 3));
          const keep = MAX_FRAMES_PER_SEGMENT - hook.length;
          picked = [...hook, ...rest.filter((_, i) => i % Math.ceil(rest.length / Math.max(1, keep)) === 0)].sort((a, b) => a - b);
        }
        segments.push({ start: s, end: e, times: picked });
      }

      const segResults: { start: number; end: number; result: SegmentResult }[] = [];
      const allTimes: number[] = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        this.progress(r, 12 + (i / segments.length) * 55, `Xem hình đoạn ${i + 1}/${segments.length} (${fmt(seg.start)}-${fmt(seg.end)})`);
        const parts: ChatContentPart[] = [
          {
            type: "text",
            text: `Đây là ${seg.times.length} khung hình trích từ đoạn ${fmt(seg.start)}-${fmt(seg.end)} của một video dài ${fmt(duration)}${i === 0 ? " (gồm các khung 0-3 giây đầu = phần hook)" : ""}. Mỗi ảnh có nhãn thời điểm đứng ngay trước. Chỉ mô tả những gì THẤY trong các khung này.`,
          },
        ];
        for (const t of seg.times) {
          const out = path.join(work, `f-${t.toFixed(2)}.jpg`);
          await extractFrame(this.ctx.media, file, t, out);
          parts.push({ type: "text", text: `[t=${t.toFixed(1)}s]` });
          parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(out).toString("base64")}` } });
          allTimes.push(t);
        }
        const result = await this.ctx.llm.json(ws, {
          model: models.vision,
          system:
            "Bạn là chuyên gia phân tích video quảng cáo. Trả lời bằng tiếng Việt, DUY NHẤT một JSON theo schema: " +
            '{"summary":string,"subjects":string[],"actions":string[],"camera":string[] (chuyển động máy suy ra từ chênh lệch giữa các khung liên tiếp),"composition":string,"lighting_color":string,"on_screen_text":string[],"transitions":string[],"moments":[{"t":number,"description":string}]}. ' +
            "Không bịa chi tiết không thấy trong khung hình. Không có thông tin âm thanh - đừng nhắc tới âm thanh.",
          user: parts,
          schema: segmentSchema,
          temperature: 0.2,
          maxTokens: 1500,
        });
        segResults.push({ start: seg.start, end: seg.end, result });
      }

      // ---- âm thanh
      let audio: AudioResult[] = [];
      const coverage: Coverage = {
        durationSec: measurements.durationSec,
        segments: segments.length,
        segmentSec: segSec,
        framesAnalyzed: allTimes.length,
        hookFrames: allTimes.filter((t) => t <= 3).length,
        frameTimes: allTimes,
        sceneCutsDetected: cuts.length,
        wholeVideoCovered: segments.length > 0 && segments[segments.length - 1]!.end >= duration - 0.01,
        audio: "not_configured",
        audioChunks: 0,
        notes: [],
      };
      if (!info.hasAudio) coverage.audio = "no_audio_track";
      else if (!models.audio) {
        coverage.audio = "not_configured";
        coverage.notes.push("Chưa cấu hình model nghe audio (Cài đặt → LLM → Model âm thanh) → CHƯA phân tích lời thoại/nhạc. Chỉ có số đo FFmpeg (khoảng lặng, độ to).");
      } else {
        try {
          const chunks = await extractAudioChunks(this.ctx.media, file, path.join(work, "audio"), duration);
          for (let i = 0; i < chunks.length; i++) {
            this.progress(r, 70 + (i / chunks.length) * 15, `Nghe âm thanh khúc ${i + 1}/${chunks.length}`);
            const b64 = fs.readFileSync(chunks[i]!).toString("base64");
            const res = await this.ctx.llm.json(ws, {
              model: models.audio,
              system:
                'Bạn nghe một đoạn âm thanh của video. Trả lời tiếng Việt, DUY NHẤT JSON: {"speech_present":boolean,"language":string,"transcript":[{"start":number,"end":number,"text":string}],"voice_tone":string,"music":string,"sound_effects":string[]}. Mốc giây tính từ đầu khúc. Không nghe rõ thì để trống, không đoán.',
              user: [
                { type: "text", text: `Khúc âm thanh ${i + 1}/${chunks.length}, bắt đầu ở giây ${i * 240} của video.` },
                { type: "input_audio", input_audio: { data: b64, format: "wav" } },
              ],
              schema: audioSchema,
              temperature: 0,
              maxTokens: 3000,
            });
            audio.push({ ...res, transcript: res.transcript.map((t) => ({ ...t, start: t.start + i * 240, end: t.end + i * 240 })) });
          }
          coverage.audio = "analyzed";
          coverage.audioChunks = chunks.length;
        } catch (e) {
          coverage.audio = "failed";
          coverage.audioError = redact((e as Error).message);
          coverage.notes.push("Phân tích âm thanh thất bại - kết quả KHÔNG gồm lời thoại/nhạc.");
          audio = [];
        }
      }

      // ---- tổng hợp
      this.progress(r, 88, "Tổng hợp kết quả");
      const synthesis = await this.ctx.llm.json(ws, {
        model: models.text,
        system:
          "Bạn là giám đốc sáng tạo phân tích video tham khảo để làm video mới. Trả lời tiếng Việt, DUY NHẤT JSON đúng schema: " +
          JSON.stringify({
            content: { summary: "", subjects: [""], storyline: [{ start: 0, end: 0, description: "" }] },
            hook: { first_seconds: "", technique: "", why_it_works: "" },
            visual_style: { look: "", lighting: "", color_palette: [""], texture: "" },
            camera: { movements: [""], shot_sizes: [""], angles: [""] },
            composition_transitions: { composition: "", transitions: [""] },
            pacing_storytelling: { structure: "", rhythm: "" },
            audio: { dialogue_summary: "", music: "", sound_effects: [""], voice: "" },
            reusable_traits: [""],
            generation_hints: { genre: "", prompt_elements: [""], avoid: [""] },
          }) +
          " Chỉ dựa trên dữ liệu được cung cấp. Nếu audio_status khác 'analyzed' thì các trường audio để chuỗi rỗng/mảng rỗng - KHÔNG suy đoán âm thanh.",
        user: JSON.stringify({ measurements, coverage: { ...coverage, frameTimes: undefined }, audio_status: coverage.audio, segments: segResults, audio }),
        schema: analysisResultSchema,
        temperature: 0.3,
        maxTokens: 3500,
      });
      // Cưỡng chế trung thực: chưa nghe thì không có nội dung âm thanh
      if (coverage.audio !== "analyzed") synthesis.audio = { dialogue_summary: "", music: "", sound_effects: [], voice: "" };
      const result = { ...synthesis, audio: { ...synthesis.audio, status: coverage.audio, transcript: audio.flatMap((a) => a.transcript) } };

      this.ctx.db.run(
        "UPDATE video_analyses SET status = 'completed', progress = 100, step = 'Hoàn thành', coverage_json = ?, result_json = ?, error = NULL, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?",
        JSON.stringify(coverage),
        JSON.stringify(result),
        nowIso(),
        r.id,
      );
      recordEvent(this.ctx.db, { workspaceId: ws, type: "analysis.status", to: "completed", data: { analysisId: r.id, assetId: r.asset_id } });
    } catch (e) {
      const msg = redact((e as Error).message);
      this.ctx.db.run("UPDATE video_analyses SET status = 'failed', step = 'Thất bại', error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?", msg, nowIso(), r.id);
      recordEvent(this.ctx.db, { workspaceId: ws, type: "analysis.status", to: "failed", message: msg, data: { analysisId: r.id } });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
