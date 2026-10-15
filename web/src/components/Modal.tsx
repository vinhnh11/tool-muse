import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

const stack: symbol[] = [];

interface Props {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Không cho đóng bằng click nền / ESC (vd đang gửi) */
  locked?: boolean;
}

export function Modal({ open, title, subtitle, onClose, children, footer, size = "md", locked }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const token = Symbol("modal");
    stack.push(token);
    const onKey = (e: KeyboardEvent) => {
      // Chỉ modal trên cùng xử lý ESC (modal lồng nhau)
      if (e.key === "Escape" && !lockedRef.current && stack[stack.length - 1] === token) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    const t = setTimeout(() => {
      const el = panel.current?.querySelector<HTMLElement>("[data-autofocus], input:not([type=checkbox]), textarea, select, button.btn-primary");
      (el ?? panel.current)?.focus();
    }, 20);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.body.classList.remove("modal-open");
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" ref={panel} tabIndex={-1}>
        <header className="modal-header">
          <div className="modal-titles">
            <h2 className="modal-title">{title}</h2>
            {subtitle ? <div className="modal-subtitle">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm btn-icon-only" onClick={onClose} disabled={locked} aria-label="Đóng" title="Đóng">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
