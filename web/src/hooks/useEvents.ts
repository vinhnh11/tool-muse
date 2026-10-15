import { useEffect, useRef, useState } from "react";
import type { RealtimeEvent } from "../api";
import { useDebouncedCallback } from "./useApi";

/**
 * Realtime qua SSE (/api/events). Server gửi sự kiện CÓ TÊN (event: job.status ...)
 * nên phải addEventListener theo từng loại - onmessage chỉ nhận sự kiện không tên.
 */
const EVENT_TYPES = [
  "job.status",
  "job.progress",
  "job.created",
  "batch.created",
  "batch.approved",
  "batch.paused",
  "batch.resumed",
  "batch.status",
  "analysis.status",
  "analysis.progress",
  "prompts.progress",
];

type Listener = (ev: RealtimeEvent) => void;
const listeners = new Set<Listener>();

export type ConnectionState = "connecting" | "open" | "closed";

function emit(ev: RealtimeEvent): void {
  for (const l of listeners) {
    try {
      l(ev);
    } catch (e) {
      console.error("[realtime] listener lỗi", e);
    }
  }
}

/** Phát sự kiện nội bộ (sau thao tác của chính người dùng) để các danh sách tải lại ngay */
export function emitLocal(partial: Partial<RealtimeEvent> & { type: string }): void {
  emit({ id: 0, batchId: null, jobId: null, from: null, to: null, message: null, data: null, at: new Date().toISOString(), ...partial });
}

/** Mở MỘT kết nối EventSource cho cả ứng dụng (gọi ở Shell khi đã đăng nhập) */
export function useEventSource(enabled: boolean): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let lastId = 0;
    let stopped = false;
    let attempts = 0;

    const handle = (raw: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(raw.data) as RealtimeEvent;
        if (typeof ev.id === "number") lastId = Math.max(lastId, ev.id);
        emit(ev);
      } catch {
        /* dữ liệu lạ - bỏ qua */
      }
    };

    const connect = () => {
      if (stopped) return;
      setState("connecting");
      es = new EventSource(lastId ? `/api/events?after=${lastId}` : "/api/events");
      es.onopen = () => {
        attempts = 0;
        setState("open");
      };
      es.onmessage = handle;
      for (const t of EVENT_TYPES) es.addEventListener(t, handle as EventListener);
      es.onerror = () => {
        if (!es) return;
        if (es.readyState === EventSource.CLOSED) {
          // Trình duyệt bỏ cuộc (vd HTTP lỗi) → tự nối lại với backoff
          setState("closed");
          es.close();
          attempts++;
          retry = setTimeout(connect, Math.min(30_000, 1500 * 2 ** Math.min(attempts, 4)));
        } else setState("connecting");
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [enabled]);
  return enabled ? state : "closed";
}

/** Nghe mọi sự kiện realtime */
export function useRealtime(handler: Listener): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const l: Listener = (ev) => ref.current(ev);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Khi có sự kiện khớp điều kiện → gọi refetch (debounce ~300ms) */
export function useRealtimeRefetch(match: (ev: RealtimeEvent) => boolean, refetch: () => void, ms = 300): void {
  const debounced = useDebouncedCallback(refetch, ms);
  const matchRef = useRef(match);
  matchRef.current = match;
  useRealtime((ev) => {
    if (matchRef.current(ev)) debounced();
  });
}
