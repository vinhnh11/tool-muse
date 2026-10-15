import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
  loading?: boolean;
  block?: boolean;
}

export function Button({ variant = "secondary", size = "md", icon, loading, block, className, children, disabled, type, ...rest }: Props) {
  const cls = ["btn", `btn-${variant}`, `btn-${size}`, block ? "btn-block" : "", !children ? "btn-icon-only" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button type={type ?? "button"} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 className="spin" size={size === "sm" ? 14 : 16} aria-hidden /> : icon}
      {children ? <span className="btn-label">{children}</span> : null}
    </button>
  );
}

/** Nút chỉ có icon - luôn có aria-label + tooltip */
export function IconButton({ label, icon, variant = "ghost", size = "sm", ...rest }: Omit<Props, "children"> & { label: string; icon: ReactNode }) {
  return <Button variant={variant} size={size} icon={icon} aria-label={label} title={label} {...rest} />;
}

/** Link tải file trông như nút */
export function LinkButton({ href, icon, children, variant = "secondary", size = "md", download = true, title }: { href: string; icon?: ReactNode; children?: ReactNode; variant?: ButtonVariant; size?: "sm" | "md"; download?: boolean; title?: string }) {
  return (
    <a className={`btn btn-${variant} btn-${size}${children ? "" : " btn-icon-only"}`} href={href} download={download || undefined} title={title} aria-label={title}>
      {icon}
      {children ? <span className="btn-label">{children}</span> : null}
    </a>
  );
}
