import { useCallback, useEffect, useState } from "react";
import { api, asApiError, setUnauthorizedHandler, type ApiError, type Me } from "./api";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { ErrorBanner, Loading } from "./components/EmptyState";
import { ToastProvider } from "./components/Toast";
import { LoginPage } from "./pages/LoginPage";
import { Shell } from "./Shell";
import { StudioProvider } from "./state/studio";

type AuthState = { kind: "checking" } | { kind: "setup" } | { kind: "login"; notice?: string } | { kind: "authed"; me: Me } | { kind: "error"; error: ApiError };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });

  const check = useCallback(async () => {
    setAuth({ kind: "checking" });
    try {
      const st = await api.setupStatus();
      if (st.needsSetup) {
        setAuth({ kind: "setup" });
        return;
      }
      const me = await api.me();
      setAuth({ kind: "authed", me });
    } catch (e) {
      const err = asApiError(e);
      if (err.status === 401) setAuth({ kind: "login" });
      else setAuth({ kind: "error", error: err });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // 401 ở bất kỳ đâu → về màn đăng nhập
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuth((s) => (s.kind === "authed" ? { kind: "login", notice: "Phiên đăng nhập đã hết hạn - vui lòng đăng nhập lại." } : s.kind === "checking" ? { kind: "login" } : s));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const onAuthed = useCallback(async () => {
    try {
      const me = await api.me();
      setAuth({ kind: "authed", me });
    } catch (e) {
      setAuth({ kind: "error", error: asApiError(e) });
    }
  }, []);

  let content;
  if (auth.kind === "checking")
    content = (
      <div className="boot">
        <Loading label="Đang kết nối máy chủ..." />
      </div>
    );
  else if (auth.kind === "error")
    content = (
      <div className="boot">
        <div className="boot-card">
          <ErrorBanner error={auth.error} title="Không tải được ứng dụng" onRetry={() => void check()} />
        </div>
      </div>
    );
  else if (auth.kind === "setup") content = <LoginPage mode="setup" onDone={onAuthed} />;
  else if (auth.kind === "login") content = <LoginPage mode="login" notice={auth.notice} onDone={onAuthed} />;
  else
    content = (
      <StudioProvider me={auth.me} onLoggedOut={() => setAuth({ kind: "login" })}>
        <Shell />
      </StudioProvider>
    );

  return (
    <ToastProvider>
      <ConfirmProvider>{content}</ConfirmProvider>
    </ToastProvider>
  );
}
