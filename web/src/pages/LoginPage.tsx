import { useState, type FormEvent } from "react";
import { Clapperboard, KeyRound, LogIn, UserPlus } from "lucide-react";
import { api, asApiError, type ApiError } from "../api";
import { Button } from "../components/Button";
import { Banner, ErrorBanner } from "../components/EmptyState";
import { Field, Input } from "../components/Field";

export function LoginPage({ mode, notice, onDone }: { mode: "login" | "setup"; notice?: string; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | { message: string } | null>(null);
  const setup = mode === "setup";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (setup) {
      if (!/^[a-z0-9_.-]{3,32}$/.test(username)) return setError({ message: "Tên đăng nhập 3-32 ký tự: chữ thường, số, dấu . _ -" });
      if (password.length < 8) return setError({ message: "Mật khẩu tối thiểu 8 ký tự." });
      if (password !== confirm) return setError({ message: "Mật khẩu nhập lại không khớp." });
    }
    setBusy(true);
    try {
      if (setup) await api.setup(username.trim(), password);
      else await api.login(username.trim(), password);
      onDone();
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden>
            <Clapperboard size={18} />
          </span>
          <div>
            <div className="auth-product">Batch Video Studio</div>
            <div className="muted small">Tạo video AI hàng loạt</div>
          </div>
        </div>
        <h1 className="auth-title">{setup ? "Tạo tài khoản quản trị" : "Đăng nhập"}</h1>
        <p className="muted">{setup ? "Chưa có tài khoản nào. Tài khoản đầu tiên là quản trị viên của workspace." : "Đăng nhập để quản lý batch video, provider và trợ lý AI."}</p>
        {notice ? <Banner tone="warning">{notice}</Banner> : null}
        <Field label="Tên đăng nhập" hint={setup ? "Chữ thường, số, dấu . _ - (3-32 ký tự)" : undefined}>
          <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Mật khẩu" hint={setup ? "Tối thiểu 8 ký tự" : undefined}>
          <Input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {setup ? (
          <Field label="Nhập lại mật khẩu">
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
        ) : null}
        <ErrorBanner error={error} compact />
        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={setup ? <UserPlus size={16} /> : <LogIn size={16} />} disabled={!username || !password}>
          {setup ? "Tạo tài khoản & đăng nhập" : "Đăng nhập"}
        </Button>
        {!setup ? (
          <p className="muted small auth-foot">
            <KeyRound size={12} aria-hidden /> Chưa có tài khoản? Quản trị viên tạo bằng lệnh <code>npm run user:create -- &lt;tên&gt; &lt;mật khẩu&gt;</code> trên máy chủ.
          </p>
        ) : null}
      </form>
    </div>
  );
}
