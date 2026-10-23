import { z } from "zod";
import type { AppContext } from "./context.ts";
import { audit, recordEvent } from "./events.ts";
import type { Actor } from "./batches.ts";
import { checkList, toCsv, toTxt, type PromptDraft } from "./prompts.ts";
import { AppError, newId, normalizeText, nowIso, safeJsonParse, similarity } from "./util.ts";
import { IMAGE_ASPECT_RATIOS, IMAGE_MODEL_ID, isImageCapable, type ModelCapabilities } from "./providers/types.ts";

/**
 * BATCH PROMPT GENERATOR + quản lý bộ prompt (prompt_sets / prompt_items).
 * Sinh ĐÚNG số lượng yêu cầu, đa dạng có chủ đích (mỗi prompt một "ô ý tưởng"
 * khác nhau: hook × bối cảnh × cấu trúc × thể loại), chống trùng bằng so khớp
 * chuẩn hóa + độ giống 3-gram, tối ưu theo giới hạn của model video đã chọn.
 */

export const GENRES = ["product", "talking-head", "cinematic", "motion-graphics", "lifestyle", "ugc-review", "tutorial", "unboxing"] as const;
const GENRE_LABEL: Record<string, string> = {
  product: "video sản phẩm (product showcase)",
  "talking-head": "người nói trước ống kính",
  cinematic: "điện ảnh (cinematic)",
  "motion-graphics": "motion graphics / chữ động",
  lifestyle: "lifestyle - sản phẩm trong đời sống",
  "ugc-review": "UGC review tự quay",
  tutorial: "hướng dẫn sử dụng",
  unboxing: "đập hộp (unboxing)",
};
const HOOKS = ["câu hỏi gây tò mò", "vấn đề/nỗi đau trực diện", "kết quả trước - quá trình sau", "chuyển động bất ngờ cận cảnh", "so sánh trước/sau", "con số/sự thật gây sốc", "tình huống hài hước", "cảnh POV ngôi thứ nhất", "đếm ngược / danh sách", "phản ứng cảm xúc mạnh"];
const STRUCTURES = ["hook → vấn đề → giải pháp → CTA", "hook → trình diễn tính năng → kết quả → CTA", "câu chuyện mini 3 hồi", "một cú máy liền (one-take)", "nhịp dựng nhanh theo beat", "so sánh A/B", "hướng dẫn từng bước", "lời chứng thực của người dùng"];
const SETTINGS = ["studio nền tối, ánh sáng viền", "căn bếp gia đình buổi sáng", "ngoài trời giờ vàng", "phòng ngủ tối giản", "văn phòng hiện đại", "đường phố đô thị ban đêm", "phòng tắm sáng sủa", "quán cà phê ấm cúng", "bàn làm việc top-down", "thiên nhiên rộng mở"];

// Ô ý tưởng cho prompt ẢNH: góc chụp × bối cảnh × phong cách (không có hook/nhịp thời gian)
const IMAGE_ANGLES = ["cận cảnh chính diện", "góc 45° từ trên xuống", "top-down phẳng (flat lay)", "góc thấp hùng vỹ", "macro chi tiết chất liệu", "cầm trên tay (POV)", "đặt trên bục trưng bày", "lệch tâm theo quy tắc 1/3", "toàn cảnh có chiều sâu trường ảnh", "bóng đổ dài ngược sáng"];
const IMAGE_STYLES = ["ảnh thương mại sạch, nền trơn", "lifestyle ấm áp tự nhiên", "tối giản màu pastel", "điện ảnh tương phản cao", "editorial tạp chí", "ánh sáng studio mềm", "mộc mạc chất liệu gỗ/vải", "tươi sáng màu rực", "sang trọng tông vàng-đen", "quảng cáo mùa lễ hội"];

const itemSchema = z.object({
  slot: z.number().int(),
  title: z.string().min(1),
  objective: z.string().default(""),
  prompt: z.string().min(10),
  negative: z.string().optional().default(""),
  genre: z.string().default(""),
});
const chunkSchema = z.object({ items: z.array(itemSchema) });

export interface GenerateArgs {
  sessionId?: string | null;
  /** "image" = viết prompt cho model TẠO ẢNH (không thời lượng/chuyển động) */
  kind?: "video" | "image";
  count: number;
  durationSec: number;
  aspectRatio: string;
  providerConfigId: string;
  modelId: string;
  genres?: string[];
  brief?: string;
  /** Giữ nhất quán: tên sản phẩm/thương hiệu/nhân vật phải xuất hiện đúng mô tả */
  consistency?: { product?: string; brand?: string; character?: string };
  referenceAssetIds?: string[];
  language?: string;
  name?: string;
}

interface ItemRow {
  id: string;
  set_id: string;
  workspace_id: string;
  idx: number;
  title: string;
  objective: string;
  prompt: string;
  negative: string | null;
  model: string | null;
  duration_sec: number | null;
  aspect_ratio: string | null;
  genre: string | null;
  reference_asset_ids_json: string;
  approval: string;
  created_at: string;
  updated_at: string;
}

export function itemToPublic(r: ItemRow) {
  return {
    id: r.id,
    setId: r.set_id,
    index: r.idx,
    title: r.title,
    objective: r.objective,
    prompt: r.prompt,
    negative: r.negative,
    model: r.model,
    durationSec: r.duration_sec,
    aspectRatio: r.aspect_ratio,
    genre: r.genre,
    referenceAssetIds: safeJsonParse<string[]>(r.reference_asset_ids_json, []),
    approval: r.approval as "pending" | "approved" | "rejected",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class PromptService {
  private ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  private modelCaps(workspaceId: string, providerConfigId: string, modelId: string): ModelCapabilities {
    const { config, adapter } = this.ctx.providers.resolveById(workspaceId, providerConfigId);
    const m = adapter.getCapabilities(config).models.find((x) => x.modelId === modelId);
    if (!m) throw new AppError("MODEL_NOT_AVAILABLE", `Model "${modelId}" không có trong provider đã chọn.`, 400);
    return m;
  }

  // ---------------------------------------------------------------- bộ prompt

  createSet(workspaceId: string, actor: Actor, args: { sessionId?: string | null; name: string; source: "ai" | "import" | "manual"; params?: unknown; items: PromptDraft[] }) {
    const id = newId("pset");
    const now = nowIso();
    this.ctx.db.tx(() => {
      this.ctx.db.run(
        "INSERT INTO prompt_sets (id, workspace_id, session_id, name, source, params_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        workspaceId,
        args.sessionId ?? null,
        args.name,
        args.source,
        JSON.stringify(args.params ?? {}),
        actor.userId,
        now,
        now,
      );
      args.items.forEach((it, i) => this.insertItem(workspaceId, id, i + 1, it));
      audit(this.ctx.db, { workspaceId, userId: actor.userId, actor: actor.kind, action: "prompts.create_set", targetType: "prompt_set", targetId: id, data: { count: args.items.length, source: args.source } });
    });
    return this.getSet(workspaceId, id);
  }

  private insertItem(workspaceId: string, setId: string, idx: number, it: PromptDraft): string {
    const id = newId("pi");
    const now = nowIso();
    this.ctx.db.run(
      `INSERT INTO prompt_items (id, set_id, workspace_id, idx, title, objective, prompt, negative, model, duration_sec, aspect_ratio, genre, reference_asset_ids_json, approval, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      setId,
      workspaceId,
      idx,
      it.title ?? "",
      it.objective ?? "",
      it.prompt.trim(),
      it.negative?.trim() || null,
      it.model ?? null,
      it.durationSec ?? null,
      it.aspectRatio ?? null,
      it.genre ?? null,
      JSON.stringify(it.referenceAssetIds ?? []),
      now,
      now,
    );
    return id;
  }

  getSet(workspaceId: string, id: string) {
    const s = this.ctx.db.get<{ id: string; session_id: string | null; name: string; source: string; params_json: string; created_at: string; updated_at: string }>(
      "SELECT * FROM prompt_sets WHERE id = ? AND workspace_id = ?",
      id,
      workspaceId,
    );
    if (!s) throw new AppError("NOT_FOUND", "Không tìm thấy bộ prompt.", 404);
    const items = this.ctx.db.all<ItemRow>("SELECT * FROM prompt_items WHERE set_id = ? ORDER BY idx", id).map(itemToPublic);
    return {
      id: s.id,
      sessionId: s.session_id,
      name: s.name,
      source: s.source,
      params: safeJsonParse(s.params_json, {}),
      items,
      counts: { total: items.length, approved: items.filter((i) => i.approval === "approved").length, rejected: items.filter((i) => i.approval === "rejected").length },
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  }

  listSets(workspaceId: string, sessionId?: string | null) {
    const rows = sessionId
      ? this.ctx.db.all<{ id: string }>("SELECT id FROM prompt_sets WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 100", workspaceId, sessionId)
      : this.ctx.db.all<{ id: string }>("SELECT id FROM prompt_sets WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100", workspaceId);
    return rows.map((r) => {
      const s = this.getSet(workspaceId, r.id);
      return { ...s, items: undefined };
    });
  }

  private itemRow(workspaceId: string, itemId: string): ItemRow {
    const r = this.ctx.db.get<ItemRow>("SELECT * FROM prompt_items WHERE id = ? AND workspace_id = ?", itemId, workspaceId);
    if (!r) throw new AppError("NOT_FOUND", "Không tìm thấy prompt.", 404);
    return r;
  }

  updateItem(workspaceId: string, itemId: string, patch: Partial<{ title: string; objective: string; prompt: string; negative: string | null; durationSec: number | null; aspectRatio: string | null; approval: string; referenceAssetIds: string[] }>) {
    this.itemRow(workspaceId, itemId);
    const map: Record<string, string> = { title: "title", objective: "objective", prompt: "prompt", negative: "negative", durationSec: "duration_sec", aspectRatio: "aspect_ratio", approval: "approval" };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (k === "approval" && !["pending", "approved", "rejected"].includes(String(v))) throw new AppError("INVALID", "approval phải là pending | approved | rejected", 400);
      if (k === "prompt" && !String(v).trim()) throw new AppError("EMPTY_PROMPT", "Prompt không được trống.", 400);
      sets.push(`${col} = ?`);
      vals.push(v === null ? null : typeof v === "number" ? v : String(v));
    }
    if (patch.referenceAssetIds) {
      sets.push("reference_asset_ids_json = ?");
      vals.push(JSON.stringify(patch.referenceAssetIds));
    }
    if (sets.length) this.ctx.db.run(`UPDATE prompt_items SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), itemId);
    return itemToPublic(this.itemRow(workspaceId, itemId));
  }

  /**
   * Xóa negative prompt của cả bộ - dùng khi đổi sang model KHÔNG nhận negative
   * (vd Muse qua muse2api). Trả về số dòng đã dọn.
   */
  clearNegatives(workspaceId: string, setId: string): number {
    this.getSet(workspaceId, setId);
    return this.ctx.db.run("UPDATE prompt_items SET negative = NULL, updated_at = ? WHERE set_id = ? AND negative IS NOT NULL AND trim(negative) <> ''", nowIso(), setId).changes;
  }

  setApproval(workspaceId: string, setId: string, itemIds: string[] | "all", approval: "pending" | "approved" | "rejected"): number {
    this.getSet(workspaceId, setId);
    if (itemIds === "all") return this.ctx.db.run("UPDATE prompt_items SET approval = ?, updated_at = ? WHERE set_id = ?", approval, nowIso(), setId).changes;
    let n = 0;
    for (const id of itemIds) n += this.ctx.db.run("UPDATE prompt_items SET approval = ?, updated_at = ? WHERE id = ? AND set_id = ?", approval, nowIso(), id, setId).changes;
    return n;
  }

  deleteItem(workspaceId: string, itemId: string): void {
    const r = this.itemRow(workspaceId, itemId);
    this.ctx.db.tx(() => {
      this.ctx.db.run("DELETE FROM prompt_items WHERE id = ?", itemId);
      this.ctx.db.run("UPDATE prompt_items SET idx = idx - 1 WHERE set_id = ? AND idx > ?", r.set_id, r.idx);
    });
  }

  duplicateItem(workspaceId: string, itemId: string) {
    const r = this.itemRow(workspaceId, itemId);
    return this.ctx.db.tx(() => {
      this.ctx.db.run("UPDATE prompt_items SET idx = idx + 1 WHERE set_id = ? AND idx > ?", r.set_id, r.idx);
      const id = this.insertItem(workspaceId, r.set_id, r.idx + 1, {
        title: `${r.title} (bản sao)`,
        objective: r.objective,
        prompt: r.prompt,
        negative: r.negative,
        durationSec: r.duration_sec,
        aspectRatio: r.aspect_ratio,
        genre: r.genre,
        referenceAssetIds: safeJsonParse(r.reference_asset_ids_json, []),
      });
      return itemToPublic(this.itemRow(workspaceId, id));
    });
  }

  addItems(workspaceId: string, setId: string, items: PromptDraft[]) {
    this.getSet(workspaceId, setId);
    const max = Number(this.ctx.db.get<{ m: number }>("SELECT MAX(idx) AS m FROM prompt_items WHERE set_id = ?", setId)?.m ?? 0);
    this.ctx.db.tx(() => items.forEach((it, i) => this.insertItem(workspaceId, setId, max + i + 1, it)));
    return this.getSet(workspaceId, setId);
  }

  exportSet(workspaceId: string, setId: string, format: "txt" | "csv" | "json", onlyApproved = false): { body: string; mime: string; fileName: string } {
    const s = this.getSet(workspaceId, setId);
    const items = s.items.filter((i) => (onlyApproved ? i.approval === "approved" : i.approval !== "rejected"));
    const base = s.name.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 50) || "prompts";
    if (format === "txt") return { body: toTxt(items.map((i) => i.prompt)), mime: "text/plain; charset=utf-8", fileName: `${base}.txt` };
    if (format === "csv")
      return {
        body: "\uFEFF" + toCsv(items.map((i) => ({ index: i.index, title: i.title, objective: i.objective, prompt: i.prompt, negative: i.negative, duration: i.durationSec, aspect: i.aspectRatio, genre: i.genre, approval: i.approval })), ["index", "title", "objective", "prompt", "negative", "duration", "aspect", "genre", "approval"]),
        mime: "text/csv; charset=utf-8",
        fileName: `${base}.csv`,
      };
    return { body: JSON.stringify({ name: s.name, prompts: items }, null, 2), mime: "application/json; charset=utf-8", fileName: `${base}.json` };
  }

  // ---------------------------------------------------------------- AI sinh prompt

  /** Caps cho prompt ảnh: provider phải làm được ảnh */
  private imageCaps(workspaceId: string, providerConfigId: string): ModelCapabilities {
    const { config, adapter } = this.ctx.providers.resolveById(workspaceId, providerConfigId);
    if (!isImageCapable(adapter)) throw new AppError("IMAGE_PROVIDER_UNSUPPORTED", "Provider này chưa hỗ trợ tạo ảnh - chọn provider Muse (muse2api).", 400);
    const m = adapter.getImageModel(config);
    return { modelId: m.modelId, label: m.label, verified: true, modes: [], durations: { min: 0, max: 0, auto: false }, aspectRatios: m.aspectRatios, resolutions: [], defaultResolution: "", audio: false, negativePrompt: false, maxPromptChars: m.maxPromptChars, maxReferenceImages: m.maxReferenceImages, qualityModes: [], seed: false, notes: m.notes };
  }

  /** Bộ prompt này viết cho ảnh? (đọc params_json, không thêm cột) */
  private setIsImage(setId: string): boolean {
    const r = this.ctx.db.get<{ params_json: string }>("SELECT params_json FROM prompt_sets WHERE id = ?", setId);
    return (safeJsonParse<{ kind?: string }>(r?.params_json, {}).kind ?? "video") === "image";
  }

  private async generateImage(workspaceId: string, actor: Actor, args: GenerateArgs) {
    const count = Math.round(args.count);
    if (!Number.isFinite(count) || count < 1 || count > 10) throw new AppError("INVALID_COUNT", "AI chỉ sinh tối đa 10 prompt mỗi lần (prompt người dùng tự nhập/nhập file thì không giới hạn).", 400);
    const caps = this.imageCaps(workspaceId, args.providerConfigId);
    if (!(IMAGE_ASPECT_RATIOS as readonly string[]).includes(args.aspectRatio)) throw new AppError("INVALID_ASPECT", `Tỉ lệ khung hình "${args.aspectRatio}" không hợp lệ - chọn ${IMAGE_ASPECT_RATIOS.join(", ")}.`, 400);
    const textModel = this.ctx.llm.model(workspaceId, "text");
    const genres = (args.genres?.length ? args.genres : ["product"]).filter((g) => g);
    const slots: { slot: number; genre: string; angle: string; setting: string; style: string }[] = [];
    for (let i = 0; i < count; i++)
      slots.push({ slot: i + 1, genre: genres[i % genres.length]!, angle: IMAGE_ANGLES[(i * 3 + Math.floor(i / IMAGE_ANGLES.length)) % IMAGE_ANGLES.length]!, setting: SETTINGS[(i * 5 + Math.floor(i / SETTINGS.length)) % SETTINGS.length]!, style: IMAGE_STYLES[(i * 7 + Math.floor(i / IMAGE_STYLES.length)) % IMAGE_STYLES.length]! });
    const lang = args.language || "vi";
    const system = [
      "Bạn là art director viết prompt cho model TẠO ẢNH AI (ảnh tĩnh).",
      `Model đích: ${caps.label}. Mỗi prompt ≤ ${Math.min(caps.maxPromptChars, 1500)} ký tự, khung ${args.aspectRatio}.`,
      "Mô tả: chủ thể, bố cục, ống kính/góc máy, ánh sáng, chất liệu, bảng màu, phong cách, bối cảnh. KHÔNG viết thời lượng, chuyển động, mốc giây, âm thanh, lời thoại.",
      "Không yêu cầu chữ/logo/watermark trong ảnh trừ khi brief nói rõ.",
      `Ngôn ngữ prompt: ${lang === "en" ? "tiếng Anh" : "tiếng Việt"}. Tiêu đề và mục tiêu viết tiếng Việt.`,
      "Mỗi prompt bám ĐÚNG ô ý tưởng được giao (góc chụp, bối cảnh, phong cách) để các prompt khác hẳn nhau.",
      'Trả DUY NHẤT JSON {"items":[{"slot":number,"title":string,"objective":string,"prompt":string,"negative":string,"genre":string}]} - đủ mọi slot được giao, "negative" để rỗng.',
    ].join("\n");
    const context = {
      brief: args.brief ?? "",
      consistency: args.consistency ?? {},
      reference_assets: args.referenceAssetIds?.length ? "1 ảnh sản phẩm tham chiếu sẽ được gửi kèm - prompt phải nhắc giữ đúng ngoại hình sản phẩm" : "",
    };
    const accepted: (z.infer<typeof itemSchema> & { slotInfo: (typeof slots)[number] })[] = [];
    const isDup = (p: string): boolean => accepted.some((a) => normalizeText(a.prompt) === normalizeText(p) || similarity(a.prompt, p) >= 0.8);
    let pending = [...slots];
    for (let round = 0; round < 30 && pending.length; round++) {
      const nextPending: typeof slots = [];
      for (let i = 0; i < pending.length; i += 5) {
        const chunk = pending.slice(i, i + 5);
        recordEvent(this.ctx.db, { workspaceId, type: "prompts.progress", message: `Đang viết prompt ảnh ${accepted.length + 1}-${Math.min(count, accepted.length + chunk.length)}/${count}` });
        const out = await this.ctx.llm.json(workspaceId, {
          model: textModel,
          system,
          user: JSON.stringify({ ...context, slots: chunk, already_used_titles: accepted.map((a) => a.title).slice(-60), already_used_openings: accepted.map((a) => a.prompt.slice(0, 80)).slice(-40) }),
          schema: chunkSchema,
          temperature: 0.9,
          maxTokens: 8000,
        });
        for (const s of chunk) {
          const it = out.items.find((x) => x.slot === s.slot);
          if (!it || !it.prompt.trim() || isDup(it.prompt)) {
            nextPending.push(s);
            continue;
          }
          let prompt = it.prompt.trim();
          if (prompt.length > caps.maxPromptChars) prompt = prompt.slice(0, caps.maxPromptChars - 1).replace(/\s+\S*$/, "") + "…";
          accepted.push({ ...it, prompt, negative: "", slotInfo: s });
        }
      }
      pending = nextPending;
    }
    accepted.sort((a, b) => a.slot - b.slot);
    const name = args.name?.trim() || `AI ${count} prompt ảnh - ${args.aspectRatio}`;
    const set = this.createSet(workspaceId, actor, {
      sessionId: args.sessionId ?? null,
      name,
      source: "ai",
      params: { ...args, kind: "image", modelId: IMAGE_MODEL_ID, model: IMAGE_MODEL_ID, durationSec: null, shortfall: count - accepted.length },
      items: accepted.map((a) => ({ title: a.title, objective: a.objective, prompt: a.prompt, negative: null, durationSec: null, aspectRatio: args.aspectRatio, model: IMAGE_MODEL_ID, genre: a.genre || a.slotInfo.genre, referenceAssetIds: args.referenceAssetIds ?? [] })),
    });
    const list = checkList(set.items.map((i) => ({ line: i.index, draft: { prompt: i.prompt } })), []);
    return {
      set,
      requested: count,
      generated: accepted.length,
      shortfall: count - accepted.length,
      duplicatesRemoved: list.duplicates.length,
      nearDuplicates: list.nearDuplicates,
      message: accepted.length === count ? `Đã tạo đủ ${count} prompt ảnh khác nhau, chờ duyệt.` : `Chỉ tạo được ${accepted.length}/${count} prompt không trùng sau nhiều vòng - đã lưu phần có được, có thể bấm "AI viết thêm".`,
    };
  }

  async generate(workspaceId: string, actor: Actor, args: GenerateArgs) {
    if (args.kind === "image") return this.generateImage(workspaceId, actor, args);
    const count = Math.round(args.count);
    if (!Number.isFinite(count) || count < 1 || count > 10) throw new AppError("INVALID_COUNT", "AI chỉ sinh tối đa 10 prompt mỗi lần (prompt người dùng tự nhập/nhập file thì không giới hạn).", 400);
    const caps = this.modelCaps(workspaceId, args.providerConfigId, args.modelId);
    // Chặn sớm: model không làm được thời lượng/tỷ lệ yêu cầu
    if (args.durationSec !== -1 && (args.durationSec < caps.durations.min || args.durationSec > caps.durations.max))
      throw new AppError("DURATION_UNSUPPORTED", `Model ${caps.label} chỉ tạo được ${caps.durations.min}-${caps.durations.max} giây - không sinh prompt ${args.durationSec} giây cho model này. Chọn model khác hoặc thời lượng khác.`, 422);
    if (!caps.aspectRatios.includes(args.aspectRatio)) throw new AppError("ASPECT_UNSUPPORTED", `Model ${caps.label} không hỗ trợ tỷ lệ ${args.aspectRatio}.`, 422);
    const textModel = this.ctx.llm.model(workspaceId, "text");

    // 1. Kế hoạch đa dạng: mỗi prompt một ô (genre × hook × cấu trúc × bối cảnh) KHÁC NHAU
    const genres = (args.genres?.length ? args.genres : ["product"]).filter((g) => g);
    const hooks = [...HOOKS];
    const structures = [...STRUCTURES];
    const slots: { slot: number; genre: string; hook: string; structure: string; setting: string }[] = [];
    for (let i = 0; i < count; i++) {
      slots.push({
        slot: i + 1,
        genre: genres[i % genres.length]!,
        hook: hooks[(i * 7 + Math.floor(i / hooks.length)) % hooks.length]!,
        structure: structures[(i * 3 + Math.floor(i / structures.length)) % structures.length]!,
        setting: SETTINGS[(i * 5 + Math.floor(i / SETTINGS.length)) % SETTINGS.length]!,
      });
    }

    const lang = args.language || "vi";
    const system = [
      "Bạn là đạo diễn sáng tạo viết prompt cho model TẠO VIDEO AI.",
      `Model đích: ${caps.label}. Mỗi prompt ≤ ${Math.min(caps.maxPromptChars, 1800)} ký tự, mô tả HÌNH ẢNH + chuyển động máy + ánh sáng + diễn biến theo thời gian cho đúng ${args.durationSec === -1 ? "thời lượng model tự chọn" : `${args.durationSec} giây`}, khung ${args.aspectRatio}.`,
      "Diễn biến phải hợp lý trong thời lượng: chia nhịp theo mốc giây (vd 0-3s hook, ...), không nhồi quá nhiều cảnh.",
      caps.audio ? "Model có tạo âm thanh: nếu có lời thoại thì đặt câu thoại trong ngoặc kép, mô tả nhạc/hiệu ứng ngắn gọn." : "Model KHÔNG tạo âm thanh: không viết lời thoại/nhạc vào prompt.",
      caps.negativePrompt ? "Có thể điền negative (những gì cần tránh)." : 'Model KHÔNG nhận negative prompt: để "negative" rỗng, đưa ràng buộc cần tránh vào prompt chính nếu thật cần.',
      `Ngôn ngữ prompt: ${lang === "en" ? "tiếng Anh" : "tiếng Việt"}. Tiêu đề và mục tiêu viết tiếng Việt.`,
      "Mỗi prompt bám ĐÚNG ô ý tưởng được giao (genre, hook, cấu trúc, bối cảnh) để các prompt khác hẳn nhau - không lặp câu mở đầu, không lặp bố cục.",
      'Trả DUY NHẤT JSON {"items":[{"slot":number,"title":string,"objective":string,"prompt":string,"negative":string,"genre":string}]} - đủ mọi slot được giao.',
    ].join("\n");
    const context = {
      brief: args.brief ?? "",
      consistency: args.consistency ?? {},
      reference_assets: args.referenceAssetIds?.length ? `${args.referenceAssetIds.length} ảnh tham chiếu (sản phẩm/nhân vật) sẽ được gửi kèm cho model video - prompt phải nhắc giữ đúng ngoại hình chúng` : "",
    };

    // 3. Sinh theo lô 5, chống trùng
    const accepted: (z.infer<typeof itemSchema> & { slotInfo: (typeof slots)[number] })[] = [];
    const isDup = (p: string): boolean => accepted.some((a) => normalizeText(a.prompt) === normalizeText(p) || similarity(a.prompt, p) >= 0.8);
    let pending = [...slots];
    for (let round = 0; round < 30 && pending.length; round++) {
      const nextPending: typeof slots = [];
      for (let i = 0; i < pending.length; i += 5) {
        const chunk = pending.slice(i, i + 5);
        recordEvent(this.ctx.db, { workspaceId, type: "prompts.progress", message: `Đang viết prompt ${accepted.length + 1}-${Math.min(count, accepted.length + chunk.length)}/${count}` });
        const out = await this.ctx.llm.json(workspaceId, {
          model: textModel,
          system,
          user: JSON.stringify({
            ...context,
            genre_labels: GENRE_LABEL,
            slots: chunk.map((s) => ({ ...s, genre_label: GENRE_LABEL[s.genre] ?? s.genre })),
            already_used_titles: accepted.map((a) => a.title).slice(-60),
            already_used_openings: accepted.map((a) => a.prompt.slice(0, 80)).slice(-40),
          }),
          schema: chunkSchema,
          temperature: 0.9,
          maxTokens: 8000,
        });
        for (const s of chunk) {
          const it = out.items.find((x) => x.slot === s.slot);
          if (!it || !it.prompt.trim() || isDup(it.prompt)) {
            nextPending.push(s);
            continue;
          }
          let prompt = it.prompt.trim();
          if (prompt.length > caps.maxPromptChars) prompt = prompt.slice(0, caps.maxPromptChars - 1).replace(/\s+\S*$/, "") + "…";
          accepted.push({ ...it, prompt, negative: caps.negativePrompt ? it.negative : "", slotInfo: s });
        }
      }
      pending = nextPending;
    }
    accepted.sort((a, b) => a.slot - b.slot);

    const name = args.name?.trim() || `AI ${count} prompt - ${args.durationSec}s ${args.aspectRatio}`;
    const set = this.createSet(workspaceId, actor, {
      sessionId: args.sessionId ?? null,
      name,
      source: "ai",
      params: { ...args, model: args.modelId, shortfall: count - accepted.length },
      items: accepted.map((a) => ({
        title: a.title,
        objective: a.objective,
        prompt: a.prompt,
        negative: a.negative || null,
        durationSec: args.durationSec,
        aspectRatio: args.aspectRatio,
        model: args.modelId,
        genre: a.genre || a.slotInfo.genre,
        referenceAssetIds: args.referenceAssetIds ?? [],
      })),
    });
    const list = checkList(
      set.items.map((i) => ({ line: i.index, draft: { prompt: i.prompt } })),
      [],
    );
    return {
      set,
      requested: count,
      generated: accepted.length,
      shortfall: count - accepted.length,
      duplicatesRemoved: list.duplicates.length,
      nearDuplicates: list.nearDuplicates,
      message:
        accepted.length === count
          ? `Đã tạo đủ ${count} prompt khác nhau, chờ duyệt.`
          : `Chỉ tạo được ${accepted.length}/${count} prompt không trùng sau nhiều vòng - đã lưu phần có được, có thể bấm "AI viết thêm".`,
    };
  }

  /** Nhờ AI viết lại MỘT prompt theo hướng dẫn */
  async rewrite(workspaceId: string, itemId: string, instruction: string, providerConfigId: string, modelId: string) {
    const r = this.itemRow(workspaceId, itemId);
    if (this.setIsImage(r.set_id)) {
      const icaps = this.imageCaps(workspaceId, providerConfigId);
      const o = await this.ctx.llm.json(workspaceId, {
        model: this.ctx.llm.model(workspaceId, "text"),
        system: `Viết lại một prompt TẠO ẢNH cho model ${icaps.label} (≤ ${Math.min(icaps.maxPromptChars, 1500)} ký tự): chủ thể, bố cục, ống kính, ánh sáng, chất liệu, bảng màu, phong cách; KHÔNG thời lượng/chuyển động/âm thanh. Trả DUY NHẤT JSON {"title":string,"objective":string,"prompt":string}.`,
        user: JSON.stringify({ current: { title: r.title, objective: r.objective, prompt: r.prompt }, instruction, aspectRatio: r.aspect_ratio }),
        schema: z.object({ title: z.string(), objective: z.string().default(""), prompt: z.string().min(10) }),
        temperature: 0.7,
        maxTokens: 2000,
      });
      return this.updateItem(workspaceId, itemId, { title: o.title, objective: o.objective, prompt: o.prompt.slice(0, icaps.maxPromptChars), negative: null, approval: "pending" });
    }
    const caps = this.modelCaps(workspaceId, providerConfigId, modelId);
    const out = await this.ctx.llm.json(workspaceId, {
      model: this.ctx.llm.model(workspaceId, "text"),
      system: `Viết lại một prompt tạo video cho model ${caps.label} (≤ ${Math.min(caps.maxPromptChars, 1800)} ký tự). ${caps.negativePrompt ? "" : "Model không nhận negative - để negative rỗng."} Trả DUY NHẤT JSON {"title":string,"objective":string,"prompt":string,"negative":string}.`,
      user: JSON.stringify({ current: { title: r.title, objective: r.objective, prompt: r.prompt, negative: r.negative }, instruction, durationSec: r.duration_sec, aspectRatio: r.aspect_ratio }),
      schema: z.object({ title: z.string(), objective: z.string().default(""), prompt: z.string().min(10), negative: z.string().default("") }),
      temperature: 0.7,
      maxTokens: 2000,
    });
    return this.updateItem(workspaceId, itemId, { title: out.title, objective: out.objective, prompt: out.prompt.slice(0, caps.maxPromptChars), negative: caps.negativePrompt ? out.negative || null : null, approval: "pending" });
  }
}
