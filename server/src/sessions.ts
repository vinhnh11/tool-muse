import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./config.ts";
import type { AppContext } from "./context.ts";
import { AppError, newId, nowIso, safeJsonParse } from "./util.ts";

// ---------------------------------------------------------------- phiên làm việc

export interface SessionRow {
  id: string;
  workspace_id: string;
  title: string;
  skill_mode: string;
  skill_ids_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function sessionToPublic(r: SessionRow) {
  return { id: r.id, title: r.title, skillMode: r.skill_mode as "auto" | "manual" | "none", skillIds: safeJsonParse<string[]>(r.skill_ids_json, []), createdAt: r.created_at, updatedAt: r.updated_at };
}

export class SessionService {
  private ctx: AppContext;
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }
  create(workspaceId: string, userId: string, title?: string) {
    const id = newId("ses");
    const now = nowIso();
    this.ctx.db.run(
      "INSERT INTO studio_sessions (id, workspace_id, title, skill_mode, skill_ids_json, created_by, created_at, updated_at) VALUES (?, ?, ?, 'auto', '[]', ?, ?, ?)",
      id,
      workspaceId,
      title?.trim() || `Phiên ${new Date().toLocaleString("vi-VN")}`,
      userId,
      now,
      now,
    );
    return this.get(workspaceId, id);
  }
  row(workspaceId: string, id: string): SessionRow {
    const r = this.ctx.db.get<SessionRow>("SELECT * FROM studio_sessions WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!r) throw new AppError("NOT_FOUND", "Không tìm thấy phiên làm việc.", 404);
    return r;
  }
  get(workspaceId: string, id: string) {
    return sessionToPublic(this.row(workspaceId, id));
  }
  list(workspaceId: string) {
    return this.ctx.db.all<SessionRow>("SELECT * FROM studio_sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 200", workspaceId).map(sessionToPublic);
  }
  update(workspaceId: string, id: string, patch: { title?: string; skillMode?: string; skillIds?: string[] }) {
    this.row(workspaceId, id);
    if (patch.skillMode && !["auto", "manual", "none"].includes(patch.skillMode)) throw new AppError("INVALID", "skillMode phải là auto | manual | none", 400);
    if (patch.skillIds) {
      const known = new Set(listSkills().map((s) => s.id));
      for (const sid of patch.skillIds) if (!known.has(sid)) throw new AppError("SKILL_NOT_FOUND", `Không có skill "${sid}".`, 422);
    }
    this.ctx.db.run(
      "UPDATE studio_sessions SET title = COALESCE(?, title), skill_mode = COALESCE(?, skill_mode), skill_ids_json = COALESCE(?, skill_ids_json), updated_at = ? WHERE id = ?",
      patch.title?.trim() || null,
      patch.skillMode ?? null,
      patch.skillIds ? JSON.stringify(patch.skillIds) : null,
      nowIso(),
      id,
    );
    return this.get(workspaceId, id);
  }
  touch(id: string): void {
    this.ctx.db.run("UPDATE studio_sessions SET updated_at = ? WHERE id = ?", nowIso(), id);
  }
}

// ---------------------------------------------------------------- skills

/**
 * Skill = hướng dẫn quy trình bằng CHỮ (skills/<id>/SKILL.md, frontmatter name +
 * description + genres). Chỉ đi vào system prompt của Chat AI - không phải mã chạy.
 */
export interface Skill {
  id: string;
  name: string;
  description: string;
  genres: string[];
  body: string;
}

const SKILLS_DIR = path.join(ROOT_DIR, "skills");

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2]!.trim() };
}

export function listSkills(): Skill[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out: Skill[] = [];
  for (const d of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^[a-z0-9-]+$/.test(d.name)) continue;
    const f = path.join(SKILLS_DIR, d.name, "SKILL.md");
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8");
    if (text.length > 64 * 1024) continue;
    const { meta, body } = parseFrontmatter(text);
    out.push({ id: d.name, name: meta.name || d.name, description: meta.description || "", genres: (meta.genres || "").split(",").map((s) => s.trim()).filter(Boolean), body });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getSkills(ids: string[]): Skill[] {
  const all = listSkills();
  return ids.map((id) => all.find((s) => s.id === id)).filter((s): s is Skill => Boolean(s));
}
