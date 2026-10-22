import { useApi } from "../../hooks/useApi";
import { api, type FbPage } from "../../api";
import { Field, Input, Select } from "../../components/Field";
import { validateShopeeUrl } from "./shopeeUrl";

/**
 * "Đăng lên Page": chọn Page Facebook đích của batch (hoặc rõ ràng "Không đăng lên Facebook").
 * Khi đã có >= 1 Page thì BẮT BUỘC chọn - không có giá trị mặc định ngầm (ô đầu là "— Chọn Page —", không chọn sẵn).
 * Server cũng kiểm lại ở BatchService.createBatch, nên đây chỉ là chặn sớm cho người dùng.
 */
export const FB_NONE = "none";

export function useFbPages() {
  const q = useApi(() => api.fbPages(), []);
  const pages: FbPage[] = q.data?.pages ?? [];
  return {
    pages,
    /** đã tải xong (lỗi tải coi như xong: server vẫn là chốt chặn cuối) */
    loaded: !q.loading,
    /** chuỗi gửi lên server: undefined khi chưa có Page nào */
    toRequest: (value: string): string | undefined => (pages.length ? value || undefined : undefined),
    /** đã đủ điều kiện để tạo batch */
    isReady: (value: string): boolean => !q.loading && (pages.length === 0 || value !== ""),
  };
}

export function FbPageSelect({ pages, value, onChange, disabled }: { pages: FbPage[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  if (!pages.length) return null;
  const chosen = pages.find((p) => p.id === value);
  const short = (id: string) => (id.length > 8 ? `…${id.slice(-6)}` : id);
  return (
    <Field label="Đăng lên Page" hint="Bắt buộc chọn. Video của batch này chỉ được đăng lên đúng Page đã chọn.">
      <Select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        options={[
          { value: "", label: "— Chọn Page —", disabled: true },
          { value: FB_NONE, label: "Không đăng lên Facebook" },
          ...pages.map((p) => ({ value: p.id, label: `${p.name} (ID ${short(p.pageId)})${p.autoEnabled ? "" : " · đang tắt tự đăng"}` })),
        ]}
      />
      {chosen && !chosen.autoEnabled ? <div className="muted tiny">Page này đang tắt tự đăng: video sẽ không vào hàng đợi cho tới khi bạn bật lại.</div> : null}
    </Field>
  );
}

/** Lỗi link Shopee để chặn nút tạo batch (null = ổn / để trống) */
export const shopeeError = (value: string): string | null => validateShopeeUrl(value);

/** Link Shopee của sản phẩm (tuỳ chọn), chỉ dùng khi batch đăng lên một Page thật */
export function ShopeeUrlField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const err = shopeeError(value);
  return (
    <Field label="Link Shopee sản phẩm (tuỳ chọn)" hint="Dán link sản phẩm (kể cả link rút gọn s.shopee.vn / shope.ee). Link sẽ được gắn cuối caption và tự bình luận dưới Reels sau khi đăng.">
      <Input type="text" value={value} disabled={disabled} placeholder="https://s.shopee.vn/..." onChange={(e) => onChange(e.target.value)} />
      {err ? <div className="tiny" style={{ color: "var(--danger, #d33)" }}>{err}</div> : null}
    </Field>
  );
}
