import { z } from "zod";
import type { AppContext } from "../context.ts";
import type { ReelsConfig } from "./config.ts";
import { redact } from "../util.ts";

export const CAPTION_MAX = 2200;

/** Thay {prompt}, {tieu_de} trong mẫu. Hàm thuần. */
export function renderTemplate(tpl: string, vars: { prompt: string; tieu_de: string }): string {
  return (tpl || "{prompt}").replace(/\{prompt\}/g, () => vars.prompt).replace(/\{tieu_de\}/g, () => vars.tieu_de);
}

/** Chuẩn hóa chuỗi hashtag: mỗi từ có '#', bỏ trùng */
export function normalizeHashtags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of (raw || "").split(/[\s,]+/)) {
    const t = w.replace(/^#+/, "").trim();
    if (!t) continue;
    const tag = `#${t}`;
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

export function composeCaption(body: string, hashtags: string): string {
  const tags = normalizeHashtags(hashtags).filter((t) => !body.toLowerCase().includes(t.toLowerCase()));
  const text = [body.trim(), tags.join(" ")].filter(Boolean).join("\n\n");
  return text.slice(0, CAPTION_MAX);
}

export interface CaptionSource {
  workspaceId: string;
  prompt: string;
  title: string;
}

const AI_SYSTEM = "Bạn viết caption ngắn (tối đa 2 câu, tiếng Việt, tự nhiên, có thể 1-2 emoji, KHÔNG hashtag) để đăng video Reels lên Facebook Page, dựa trên prompt tạo video. Trả JSON: {\"caption\": \"...\"}.";

/** Caption: AI (nếu bật) rồi rơi về mẫu khi lỗi/rỗng/quá 20 giây; sau đó nối hashtag mặc định */
export async function buildCaption(ctx: AppContext, src: CaptionSource, cfg: ReelsConfig): Promise<string> {
  const vars = { prompt: src.prompt.trim(), tieu_de: src.title.trim() };
  let body = "";
  if (cfg.aiCaption && vars.prompt) {
    try {
      const r = await Promise.race([
        ctx.llm.json(src.workspaceId, { model: ctx.llm.model(src.workspaceId, "text"), system: AI_SYSTEM, user: vars.prompt.slice(0, 3000), schema: z.object({ caption: z.string() }), temperature: 0.7, maxTokens: 300 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 20_000).unref()),
      ]);
      body = r.caption.trim();
    } catch (e) {
      console.warn(`[fbreels] Caption AI lỗi, dùng mẫu: ${redact((e as Error).message)}`);
    }
  }
  if (!body) body = renderTemplate(cfg.captionTemplate, vars).trim();
  return composeCaption(body, cfg.hashtags);
}
