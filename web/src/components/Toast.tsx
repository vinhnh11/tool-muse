import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { asApiError } from "../api";
import { isLlmError, isLlmNotConfigured } from "../labels";

type ToastKind = "success" | "error" | "info" | "warning";
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  show: (t: Omit<ToastItem, "id">, ms?: number) => void;
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string, action?: ToastItem["action"]) => void;
  info: (title: string, detail?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

const ICON: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 size={18} />,
  error: <XCircle size={18} />,
  info: <Info size={18} />,
  warning: <AlertTriangle size={18} />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (t: Omit<ToastItem, "id">, ms?: number) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-4), { ...t, id }]);
      setTimeout(() => dismiss(id), ms ?? (t.kind === "error" ? 9000 : 4500));
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, detail) => show({ kind: "success", title, detail }),
      error: (title, detail, action) => show({ kind: "error", title, detail, action }),
      info: (title, detail) => show({ kind: "info", title, detail }),
    }),
    [show],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-icon">{ICON[t.kind]}</span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.detail ? <div className="toast-detail">{t.detail}</div> : null}
              {t.action ? (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
            <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Đóng thông báo">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast ngoài ToastProvider");
  return c;
}

/** Toast lỗi API; lỗi LLM (chưa cấu hình...) có nút mở Cài đặt */
export function toastApiError(toast: ToastApi, title: string, e: unknown): void {
  const err = asApiError(e);
  const llm = isLlmError(err.code);
  toast.error(isLlmNotConfigured(err.code) ? `${title} - chưa cấu hình LLM` : title, err.message, llm ? { label: "Mở Cài đặt LLM", onClick: () => (window.location.hash = "#/settings") } : undefined);
}
