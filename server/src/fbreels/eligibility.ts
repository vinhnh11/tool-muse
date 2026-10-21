/** Điều kiện đăng Reels: MP4, 9:16, 3–90 giây, tối thiểu 540x960. Hàm thuần để dễ test. */
export const REEL_MIN_SEC = 3;
export const REEL_MAX_SEC = 90;
export const REEL_MIN_W = 540;
export const REEL_MIN_H = 960;
/** Upload cả file vào RAM nên chặn file quá lớn */
export const REEL_MAX_BYTES = 200 * 1024 * 1024;

export interface ReelVideoInfo {
  durationSec: number | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
  mime?: string | null;
  fileName?: string | null;
  sizeBytes?: number | null;
}

export type Eligibility = { ok: true } | { ok: false; reason: string };

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

export function checkReelEligibility(a: ReelVideoInfo): Eligibility {
  const { durationSec: d, width: w, height: h } = a;
  if (a.mime && !/^video\/mp4$/i.test(a.mime)) return { ok: false, reason: `Không phải MP4 (${a.mime}), Reels chỉ nhận MP4.` };
  if (!a.mime && a.fileName && !/\.mp4$/i.test(a.fileName)) return { ok: false, reason: "Không phải MP4, Reels chỉ nhận MP4." };
  if (!d || !w || !h || !(d > 0) || !(w > 0) || !(h > 0)) return { ok: false, reason: "Không đọc được thông tin video (ffprobe), nên không đăng." };
  if (d < REEL_MIN_SEC) return { ok: false, reason: `Video ngắn hơn ${REEL_MIN_SEC} giây (${fmt(d)}s), Reels yêu cầu ${REEL_MIN_SEC}–${REEL_MAX_SEC} giây.` };
  if (d > REEL_MAX_SEC) return { ok: false, reason: `Video dài hơn ${REEL_MAX_SEC} giây (${fmt(d)}s), Reels yêu cầu ${REEL_MIN_SEC}–${REEL_MAX_SEC} giây.` };
  if (Math.abs(w / h - 9 / 16) > 0.01) return { ok: false, reason: `Không phải tỷ lệ 9:16 (${w}x${h}).` };
  if (w < REEL_MIN_W || h < REEL_MIN_H) return { ok: false, reason: `Độ phân giải thấp hơn tối thiểu ${REEL_MIN_W}x${REEL_MIN_H} (${w}x${h}).` };
  if (a.sizeBytes && a.sizeBytes > REEL_MAX_BYTES) return { ok: false, reason: "File quá lớn (trên 200MB) để đăng Reels." };
  return { ok: true };
}
