import { useEffect, useState, type ReactNode } from "react";
import { Bot, Clapperboard, Library, LogOut, Menu, PanelRightClose, PanelRightOpen, Plug, Plus, Settings, Share2, X } from "lucide-react";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { useDialogs } from "./components/ConfirmDialog";
import { useToast } from "./components/Toast";
import { ChatPanel } from "./chat/ChatPanel";
import { asApiError } from "./api";
import { useLocalStorage } from "./hooks/useApi";
import { useEventSource, type ConnectionState } from "./hooks/useEvents";
import { BatchStudio } from "./pages/batch/BatchStudio";
import { FacebookPage } from "./pages/FacebookPage";
import { LibraryPage } from "./pages/LibraryPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useStudio, type PageId } from "./state/studio";

const NAV: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "batch", label: "Batch Studio", icon: <Clapperboard size={18} /> },
  { id: "library", label: "Thư viện", icon: <Library size={18} /> },
  { id: "providers", label: "Provider", icon: <Plug size={18} /> },
  { id: "facebook", label: "Facebook", icon: <Share2 size={18} /> },
  { id: "settings", label: "Cài đặt", icon: <Settings size={18} /> },
];

const CONN_TEXT: Record<ConnectionState, string> = {
  open: "Realtime: đã kết nối",
  connecting: "Realtime: đang kết nối...",
  closed: "Realtime: mất kết nối - đang thử lại",
};

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 899px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 899px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function SessionSelector() {
  const { sessions, sessionId, setSessionId, createSession, sessionsLoading } = useStudio();
  const dialogs = useDialogs();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const title = await dialogs.prompt({ title: "Tạo phiên làm việc mới", label: "Tên phiên", placeholder: "vd: Chiến dịch serum tháng 11", confirmLabel: "Tạo phiên" });
    if (title === null) return;
    setBusy(true);
    try {
      const s = await createSession(title);
      toast.success(`Đã tạo phiên "${s.title}"`);
    } catch (e) {
      toast.error("Không tạo được phiên", asApiError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="session-select">
      <span className="session-label">Phiên</span>
      {sessions.length ? (
        <select className="input select input-sm" value={sessionId ?? ""} onChange={(e) => setSessionId(e.target.value || null)} aria-label="Chọn phiên làm việc">
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      ) : (
        <span className="muted small">{sessionsLoading ? "Đang tải..." : "Chưa có phiên"}</span>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={create} disabled={busy} title="Tạo phiên mới">
        <Plus size={14} />
        <span className="btn-label hide-xs">Phiên mới</span>
      </button>
    </div>
  );
}

export function Shell() {
  const studio = useStudio();
  const { page, navigate, me, logout, approval, closeApproval } = studio;
  const conn = useEventSource(true);
  const narrow = useIsNarrow();
  const [drawer, setDrawer] = useState(false);
  const [chatOpenDesktop, setChatOpenDesktop] = useLocalStorage<boolean>("bvs.chat.open", true);
  const [chatOpenMobile, setChatOpenMobile] = useState(false);
  const chatOpen = narrow ? chatOpenMobile : chatOpenDesktop;
  const setChatOpen = (v: boolean) => (narrow ? setChatOpenMobile(v) : setChatOpenDesktop(v));

  useEffect(() => setDrawer(false), [page]);

  const nav = (
    <nav className="rail-nav" aria-label="Điều hướng chính">
      {NAV.map((n) => (
        <a
          key={n.id}
          href={`#/${n.id}`}
          className={`rail-link${page === n.id ? " is-active" : ""}`}
          aria-current={page === n.id ? "page" : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate(n.id);
          }}
        >
          {n.icon}
          <span>{n.label}</span>
        </a>
      ))}
    </nav>
  );

  const railFooter = (
    <div className="rail-footer">
      <div className={`conn conn-${conn}`} title={CONN_TEXT[conn]}>
        <span className="conn-dot" aria-hidden />
        <span>{conn === "open" ? "Realtime" : conn === "connecting" ? "Đang kết nối" : "Mất kết nối"}</span>
      </div>
      <div className="rail-user">
        <div className="avatar" aria-hidden>
          {me.user.username.slice(0, 1).toUpperCase()}
        </div>
        <div className="rail-user-text">
          <div className="rail-user-name">{me.user.username}</div>
          <div className="muted tiny">{me.workspaces.find((w) => w.id === me.workspaceId)?.name ?? me.user.role}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm btn-icon-only" onClick={() => void logout()} title="Đăng xuất" aria-label="Đăng xuất">
          <LogOut size={15} />
        </button>
      </div>
    </div>
  );

  const brand = (
    <div className="brand">
      <span className="brand-mark" aria-hidden>
        <Clapperboard size={16} />
      </span>
      <span className="brand-name">Batch Video Studio</span>
    </div>
  );

  return (
    <div className={`app${chatOpen && !narrow ? " with-chat" : ""}`}>
      {!narrow ? (
        <aside className="rail">
          {brand}
          {nav}
          {railFooter}
        </aside>
      ) : null}

      {narrow && drawer ? (
        <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
          <aside className="rail drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              {brand}
              <button type="button" className="btn btn-ghost btn-sm btn-icon-only" onClick={() => setDrawer(false)} aria-label="Đóng menu">
                <X size={16} />
              </button>
            </div>
            {nav}
            {railFooter}
          </aside>
        </div>
      ) : null}

      <div className="main-col">
        <header className="topbar">
          {narrow ? (
            <button type="button" className="btn btn-ghost btn-sm btn-icon-only" onClick={() => setDrawer(true)} aria-label="Mở menu">
              <Menu size={18} />
            </button>
          ) : null}
          {narrow ? <span className="topbar-title">{NAV.find((n) => n.id === page)?.label}</span> : <h1 className="topbar-title">{NAV.find((n) => n.id === page)?.label}</h1>}
          <div className="topbar-spacer" />
          <SessionSelector />
          {!narrow ? (
            <span className={`conn conn-${conn} conn-compact`} title={CONN_TEXT[conn]}>
              <span className="conn-dot" aria-hidden />
            </span>
          ) : null}
          <button type="button" className={`btn btn-sm ${chatOpen ? "btn-secondary" : "btn-primary"}`} onClick={() => setChatOpen(!chatOpen)} aria-pressed={chatOpen} title={chatOpen ? "Ẩn Trợ lý AI" : "Mở Trợ lý AI"}>
            {narrow ? <Bot size={15} /> : chatOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            <span className="btn-label hide-xs">Trợ lý AI</span>
          </button>
        </header>
        <main className="page" id="main">
          {page === "batch" ? <BatchStudio /> : null}
          {page === "library" ? <LibraryPage /> : null}
          {page === "providers" ? <ProvidersPage /> : null}
          {page === "facebook" ? <FacebookPage /> : null}
          {page === "settings" ? <SettingsPage /> : null}
        </main>
      </div>

      {chatOpen ? (
        narrow ? (
          <div className="drawer-backdrop drawer-right" onClick={() => setChatOpen(false)}>
            <aside className="chat-aside drawer" onClick={(e) => e.stopPropagation()}>
              <ChatPanel onClose={() => setChatOpen(false)} />
            </aside>
          </div>
        ) : (
          <aside className="chat-aside">
            <ChatPanel onClose={() => setChatOpen(false)} />
          </aside>
        )
      ) : null}

      {approval ? <ApprovalDialog batchId={approval.batchId} initialEstimate={approval.estimate ?? null} onClose={closeApproval} /> : null}
    </div>
  );
}
