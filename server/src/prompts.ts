import { normalizeText, similarity } from "./util.ts";

/** Một prompt chờ tạo video (từ AI, file, dán tay) */
export interface PromptDraft {
  title?: string;
  objective?: string;
  prompt: string;
  negative?: string | null;
  durationSec?: number | null;
  aspectRatio?: string | null;
  model?: string | null;
  genre?: string | null;
  referenceAssetIds?: string[];
}

export interface ParsedLine {
  /** Số dòng/bản ghi trong file gốc (1-based) */
  line: number;
  draft: PromptDraft;
}

export interface ParseResult {
  format: "txt" | "csv" | "json";
  items: ParsedLine[];
  blankLines: number[];
  errors: { line: number; message: string }[];
}

// ------------------------------------------------------------------ Nhập

export function detectFormat(fileName: string | undefined, text: string): "txt" | "csv" | "json" {
  const ext = (fileName ?? "").toLowerCase().split(".").pop();
  if (ext === "json") return "json";
  if (ext === "csv") return "csv";
  if (ext === "txt") return "txt";
  const t = text.trimStart();
  if (t.startsWith("[") || t.startsWith("{")) return "json";
  return "txt";
}

export function parsePrompts(text: string, format: "txt" | "csv" | "json"): ParseResult {
  const clean = text.replace(/^\uFEFF/, "");
  if (format === "json") return parseJson(clean);
  if (format === "csv") return parseCsvPrompts(clean);
  // TXT: MỖI DÒNG LÀ MỘT PROMPT
  const items: ParsedLine[] = [];
  const blankLines: number[] = [];
  const lines = clean.split(/\r?\n/);
  // Dòng trống cuối file (do xuống dòng cuối) không tính là "dòng trống" lỗi
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  lines.forEach((l, i) => {
    if (!l.trim()) blankLines.push(i + 1);
    else items.push({ line: i + 1, draft: { prompt: l.trim() } });
  });
  return { format: "txt", items, blankLines, errors: [] };
}

function parseJson(text: string): ParseResult {
  const errors: { line: number; message: string }[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { format: "json", items: [], blankLines: [], errors: [{ line: 1, message: `JSON không hợp lệ: ${(e as Error).message}` }] };
  }
  const arr = Array.isArray(data) ? data : Array.isArray((data as { prompts?: unknown[] })?.prompts) ? (data as { prompts: unknown[] }).prompts : null;
  if (!arr) return { format: "json", items: [], blankLines: [], errors: [{ line: 1, message: "JSON phải là mảng prompt hoặc { \"prompts\": [...] }." }] };
  const items: ParsedLine[] = [];
  const blankLines: number[] = [];
  arr.forEach((x, i) => {
    if (typeof x === "string") {
      if (!x.trim()) blankLines.push(i + 1);
      else items.push({ line: i + 1, draft: { prompt: x.trim() } });
      return;
    }
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const prompt = String(o.prompt ?? o.content ?? "").trim();
      if (!prompt) {
        blankLines.push(i + 1);
        return;
      }
      items.push({
        line: i + 1,
        draft: {
          prompt,
          title: o.title ? String(o.title) : undefined,
          objective: o.objective ? String(o.objective) : undefined,
          negative: o.negative ? String(o.negative) : o.negativePrompt ? String(o.negativePrompt) : null,
          durationSec: o.durationSec ?? o.duration ? Number(o.durationSec ?? o.duration) : null,
          aspectRatio: o.aspectRatio ?? o.ratio ? String(o.aspectRatio ?? o.ratio) : null,
          model: o.model ? String(o.model) : null,
          genre: o.genre ? String(o.genre) : null,
          referenceAssetIds: Array.isArray(o.referenceAssetIds) ? o.referenceAssetIds.map(String) : undefined,
        },
      });
      return;
    }
    errors.push({ line: i + 1, message: "Phần tử không phải chuỗi hoặc object." });
  });
  return { format: "json", items, blankLines, errors };
}

/** Bộ đọc CSV chuẩn RFC 4180 (ngoặc kép, xuống dòng trong ô) */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function parseCsvPrompts(text: string): ParseResult {
  const rows = parseCsv(text);
  while (rows.length && rows[rows.length - 1]!.every((c) => !c.trim())) rows.pop();
  const items: ParsedLine[] = [];
  const blankLines: number[] = [];
  if (!rows.length) return { format: "csv", items, blankLines, errors: [] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes("prompt");
  const col = (name: string) => header.indexOf(name);
  const start = hasHeader ? 1 : 0;
  for (let r = start; r < rows.length; r++) {
    const cells = rows[r]!;
    const get = (name: string): string => (hasHeader && col(name) >= 0 ? (cells[col(name)] ?? "").trim() : "");
    const prompt = hasHeader ? get("prompt") : (cells[0] ?? "").trim();
    if (!prompt) {
      blankLines.push(r + 1);
      continue;
    }
    const dur = get("duration") || get("durationsec") || get("duration_sec");
    items.push({
      line: r + 1,
      draft: {
        prompt,
        title: get("title") || undefined,
        objective: get("objective") || undefined,
        negative: get("negative") || get("negative_prompt") || null,
        durationSec: dur ? Number(dur) : null,
        aspectRatio: get("aspect") || get("aspectratio") || get("ratio") || null,
        model: get("model") || null,
        genre: get("genre") || null,
      },
    });
  }
  return { format: "csv", items, blankLines, errors: [] };
}

// ------------------------------------------------------------------ Kiểm

export interface ListCheck {
  totalLines: number;
  blankLines: number[];
  duplicates: { line: number; duplicateOfLine: number }[];
  nearDuplicates: { line: number; similarToLine: number; score: number }[];
  /** Dòng hợp lệ = không trống, không trùng hệt */
  uniqueLines: number[];
}

/** Trùng hệt (sau chuẩn hóa) = lỗi; gần trùng (≥0.9) = cảnh báo */
export function checkList(items: ParsedLine[], blankLines: number[]): ListCheck {
  const seen = new Map<string, number>();
  const duplicates: ListCheck["duplicates"] = [];
  const uniqueLines: number[] = [];
  const uniqueTexts: { line: number; text: string }[] = [];
  for (const it of items) {
    const key = normalizeText(it.draft.prompt);
    const prev = seen.get(key);
    if (prev !== undefined) duplicates.push({ line: it.line, duplicateOfLine: prev });
    else {
      seen.set(key, it.line);
      uniqueLines.push(it.line);
      uniqueTexts.push({ line: it.line, text: it.draft.prompt });
    }
  }
  const nearDuplicates: ListCheck["nearDuplicates"] = [];
  if (uniqueTexts.length <= 400) {
    for (let i = 0; i < uniqueTexts.length; i++) {
      for (let j = 0; j < i; j++) {
        const s = similarity(uniqueTexts[i]!.text, uniqueTexts[j]!.text);
        if (s >= 0.9) {
          nearDuplicates.push({ line: uniqueTexts[i]!.line, similarToLine: uniqueTexts[j]!.line, score: Math.round(s * 100) / 100 });
          break;
        }
      }
    }
  }
  return { totalLines: items.length + blankLines.length, blankLines, duplicates, nearDuplicates, uniqueLines };
}

// ------------------------------------------------------------------ Xuất

export function toTxt(prompts: string[]): string {
  // Mỗi dòng một prompt → xuống dòng trong prompt bị gộp thành khoảng trắng
  return prompts.map((p) => p.replace(/\s*\r?\n\s*/g, " ").trim()).join("\n") + "\n";
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}
