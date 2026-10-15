import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, asApiError } from "../api";

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  /** true chỉ ở lần tải đầu (chưa có dữ liệu) */
  loading: boolean;
  /** đang tải lại ngầm */
  refreshing: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | null | ((prev: T | null) => T | null)) => void;
}

/**
 * Gọi API theo deps; tải lại ngầm (không nháy loading) khi gọi reload().
 * Bỏ kết quả cũ nếu có lượt gọi mới hơn (tránh race).
 */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[], opts: { enabled?: boolean } = {}): ApiState<T> {
  const enabled = opts.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const hasData = useRef(false);

  const run = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const my = ++seq.current;
    if (hasData.current) setRefreshing(true);
    else setLoading(true);
    try {
      const out = await fnRef.current();
      if (my !== seq.current) return;
      hasData.current = true;
      setData(out);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError(asApiError(e));
    } finally {
      if (my === seq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useEffect(() => {
    hasData.current = false;
    setData(null);
    setError(null);
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  return { data, error, loading, refreshing, reload: run, setData };
}

/** Gọi fn định kỳ khi enabled (dự phòng khi SSE rớt) */
export function usePoll(fn: () => void, intervalMs: number, enabled: boolean): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") ref.current();
    }, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** State lưu trong localStorage (khôi phục sau F5) */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        try {
          if (next === undefined || next === null) localStorage.removeItem(key);
          else localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* bộ nhớ đầy / chế độ riêng tư - bỏ qua */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

/** Hàm debounce ổn định giữa các lần render */
export function useDebouncedCallback(fn: () => void, ms: number): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current(), ms);
  }, [ms]);
}
