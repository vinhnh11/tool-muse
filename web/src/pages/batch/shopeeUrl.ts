/** Báo sớm lỗi link Shopee. PHẢI khớp quy tắc ở server/src/fbreels/shopee.ts (server là chốt chặn cuối). Trả null nếu ổn. */
export const SHOPEE_URL_MAX = 500;
const EXACT_HOSTS = new Set(["shopee.vn", "shopee.com", "s.shopee.vn", "shope.ee", "vn.shp.ee", "shp.ee"]);

export function validateShopeeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null; // rỗng = không dùng link
  if (s.length > SHOPEE_URL_MAX) return `Link Shopee dài quá ${SHOPEE_URL_MAX} ký tự.`;
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return "Link Shopee không được chứa khoảng trắng.";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return "Link Shopee không hợp lệ.";
  }
  if (u.protocol !== "https:") return "Link Shopee phải bắt đầu bằng https://.";
  if (u.username || u.password) return "Link Shopee không hợp lệ.";
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!(EXACT_HOSTS.has(h) || h.endsWith(".shopee.vn"))) return "Link Shopee chỉ nhận shopee.vn, shopee.com, s.shopee.vn, shope.ee, vn.shp.ee, shp.ee.";
  return null;
}
