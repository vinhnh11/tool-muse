import { AppError } from "../util.ts";

export const SHOPEE_URL_MAX = 500;

/** Host chính xác được phép (ngoài shopee.vn và *.shopee.vn) */
const EXACT_HOSTS = new Set(["shopee.vn", "shopee.com", "s.shopee.vn", "shope.ee", "vn.shp.ee", "shp.ee"]);

export type ShopeeUrlResult = { ok: true; url: string } | { ok: false; message: string };

/**
 * Kiểm tra link Shopee do người dùng dán. Hàm thuần: KHÔNG gọi mạng, KHÔNG theo redirect.
 * Phải khớp web/src/pages/batch/shopeeUrl.ts.
 */
export function validateShopeeUrl(raw: unknown): ShopeeUrlResult {
  if (typeof raw !== "string") return { ok: false, message: "Link Shopee không hợp lệ." };
  const s = raw.trim();
  if (!s) return { ok: false, message: "Link Shopee không hợp lệ." };
  if (s.length > SHOPEE_URL_MAX) return { ok: false, message: `Link Shopee dài quá ${SHOPEE_URL_MAX} ký tự.` };
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return { ok: false, message: "Link Shopee không được chứa khoảng trắng." };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, message: "Link Shopee không hợp lệ." };
  }
  if (u.protocol !== "https:") return { ok: false, message: "Link Shopee phải bắt đầu bằng https://." };
  if (u.username || u.password) return { ok: false, message: "Link Shopee không hợp lệ." };
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!(EXACT_HOSTS.has(h) || h.endsWith(".shopee.vn"))) return { ok: false, message: "Link Shopee chỉ nhận shopee.vn, shopee.com, s.shopee.vn, shope.ee, vn.shp.ee, shp.ee." };
  return { ok: true, url: s };
}

/** null/undefined/"" => null (không có link); sai => ném AppError 400 */
export function normalizeShopeeUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && !raw.trim()) return null;
  const r = validateShopeeUrl(raw);
  if (!r.ok) throw new AppError("SHOPEE_URL_INVALID", r.message, 400);
  return r.url;
}
