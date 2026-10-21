import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type ApiError, type BatchEstimate, type Me, type ProviderConfig, type Session } from "../api";
import { useApi, useLocalStorage } from "../hooks/useApi";
import { useRealtimeRefetch } from "../hooks/useEvents";

export type PageId = "batch" | "library" | "providers" | "facebook" | "settings";
export const PAGES: PageId[] = ["batch", "library", "providers", "facebook", "settings"];

function readHash(): PageId {
  const h = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] as PageId;
  return PAGES.includes(h) ? h : "batch";
}

interface ApprovalRequest {
  batchId: string;
  estimate?: BatchEstimate | null;
}

export interface StudioState {
  me: Me;
  logout: () => Promise<void>;
  page: PageId;
  navigate: (p: PageId) => void;

  sessions: Session[];
  sessionsLoading: boolean;
  sessionId: string | null;
  session: Session | null;
  setSessionId: (id: string | null) => void;
  createSession: (title?: string) => Promise<Session>;
  reloadSessions: () => Promise<void>;

  providers: ProviderConfig[];
  providersLoading: boolean;
  providersError: ApiError | null;
  reloadProviders: () => Promise<void>;

  /** Batch đang mở ở Batch Studio (lưu localStorage) */
  selectedBatchId: string | null;
  setSelectedBatchId: (id: string | null) => void;
  /** Bộ prompt đang duyệt ở Batch Studio */
  activeSetId: string | null;
  setActiveSetId: (id: string | null) => void;

  approval: ApprovalRequest | null;
  openApproval: (batchId: string, estimate?: BatchEstimate | null) => void;
  closeApproval: () => void;
}

const Ctx = createContext<StudioState | null>(null);

export function StudioProvider({ me, onLoggedOut, children }: { me: Me; onLoggedOut: () => void; children: ReactNode }) {
  const [page, setPage] = useState<PageId>(readHash);
  useEffect(() => {
    const onHash = () => setPage(readHash());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) window.history.replaceState(null, "", "#/batch");
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = useCallback((p: PageId) => {
    if (readHash() !== p || !window.location.hash) window.location.hash = `#/${p}`;
    setPage(p);
  }, []);

  const sessionsQ = useApi(() => api.sessions().then((r) => r.sessions), []);
  const providersQ = useApi(() => api.providers().then((r) => r.providers), []);
  const [sessionId, setSessionIdRaw] = useLocalStorage<string | null>("bvs.session", null);
  const [selectedBatchId, setSelectedBatchId] = useLocalStorage<string | null>("bvs.batch.selected", null);
  const [activeSetId, setActiveSetId] = useLocalStorage<string | null>("bvs.promptSet.active", null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);

  const sessions = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);
  // Phiên đã lưu không còn → chọn phiên mới nhất
  useEffect(() => {
    if (!sessionsQ.data) return;
    if (sessionId && sessionsQ.data.some((s) => s.id === sessionId)) return;
    setSessionIdRaw(sessionsQ.data[0]?.id ?? null);
  }, [sessionsQ.data, sessionId, setSessionIdRaw]);

  // Provider có thể đổi trạng thái (test, sửa ở tab khác) - tải lại khi có sự kiện batch
  useRealtimeRefetch((ev) => ev.type === "local.providers", () => void providersQ.reload(), 100);

  const setSessionId = useCallback(
    (id: string | null) => {
      setSessionIdRaw(id);
      setActiveSetId(null);
    },
    [setSessionIdRaw, setActiveSetId],
  );

  const createSession = useCallback(
    async (title?: string) => {
      const s = await api.createSession(title?.trim() || undefined);
      await sessionsQ.reload();
      setSessionId(s.id);
      return s;
    },
    [sessionsQ, setSessionId],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      onLoggedOut();
    }
  }, [onLoggedOut]);

  const value: StudioState = {
    me,
    logout,
    page,
    navigate,
    sessions,
    sessionsLoading: sessionsQ.loading,
    sessionId,
    session: sessions.find((s) => s.id === sessionId) ?? null,
    setSessionId,
    createSession,
    reloadSessions: sessionsQ.reload,
    providers: providersQ.data ?? [],
    providersLoading: providersQ.loading,
    providersError: providersQ.error,
    reloadProviders: providersQ.reload,
    selectedBatchId,
    setSelectedBatchId,
    activeSetId,
    setActiveSetId,
    approval,
    openApproval: (batchId, estimate) => setApproval({ batchId, estimate }),
    closeApproval: () => setApproval(null),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStudio(): StudioState {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStudio ngoài StudioProvider");
  return c;
}
