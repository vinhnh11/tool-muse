import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";

interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOptions extends ConfirmOptions {
  label: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
  required?: boolean;
}

interface DialogApi {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: PromptOptions) => Promise<string | null>;
}

const Ctx = createContext<DialogApi | null>(null);

type State = { kind: "confirm"; o: ConfirmOptions } | { kind: "prompt"; o: PromptOptions } | null;

/** Hộp xác nhận / nhập liệu dùng chung (thay window.confirm / prompt) */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const [text, setText] = useState("");
  const resolver = useRef<((v: boolean | string | null) => void) | null>(null);

  const close = (v: boolean | string | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setState(null);
  };

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = (v) => resolve(v === true);
        setState({ kind: "confirm", o });
      }),
    [],
  );
  const prompt = useCallback(
    (o: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        resolver.current = (v) => resolve(typeof v === "string" ? v : null);
        setText(o.initial ?? "");
        setState({ kind: "prompt", o });
      }),
    [],
  );

  const o = state?.o;
  const promptState = state?.kind === "prompt" ? state.o : null;
  const canSubmit = !promptState?.required || text.trim().length > 0;
  return (
    <Ctx.Provider value={{ confirm, prompt }}>
      {children}
      <Modal
        open={Boolean(state)}
        size="sm"
        title={o?.title ?? ""}
        onClose={() => close(state?.kind === "prompt" ? null : false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(state?.kind === "prompt" ? null : false)}>
              {o?.cancelLabel ?? "Hủy"}
            </Button>
            <Button variant={o?.danger ? "danger" : "primary"} disabled={!canSubmit} onClick={() => close(state?.kind === "prompt" ? text : true)}>
              {o?.confirmLabel ?? "Xác nhận"}
            </Button>
          </>
        }
      >
        {o?.body ? <div className="confirm-body">{o.body}</div> : null}
        {promptState ? (
          <label className="field">
            <span className="field-label">{promptState.label}</span>
            {promptState.multiline ? (
              <textarea className="input" rows={4} value={text} placeholder={promptState.placeholder} onChange={(e) => setText(e.target.value)} data-autofocus />
            ) : (
              <input
                className="input"
                value={text}
                placeholder={promptState.placeholder}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) close(text);
                }}
                data-autofocus
              />
            )}
          </label>
        ) : null}
      </Modal>
    </Ctx.Provider>
  );
}

export function useDialogs(): DialogApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDialogs ngoài ConfirmProvider");
  return c;
}
