import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * In-page replacements for window.confirm / prompt / alert. The native ones can be switched off
 * by the browser ("prevent this page from creating additional dialogs"), after which confirm()
 * silently returns false and every confirmed button stops working.
 */
interface Dialogs {
  confirm(message: string, opts?: { ok?: string; danger?: boolean }): Promise<boolean>;
  /** A text answer (empty string allowed), or null if cancelled. With `options`, a choice from a list. */
  prompt(message: string, opts?: { initial?: string; ok?: string; options?: { value: string; label: string }[] }): Promise<string | null>;
  alert(message: string): Promise<void>;
}

type Request = { id: number } & (
  | { kind: "confirm"; message: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: "prompt"; message: string; ok: string; initial: string; options?: { value: string; label: string }[]; resolve: (v: string | null) => void }
  | { kind: "alert"; message: string; resolve: () => void }
);

let nextId = 0;

const DialogContext = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
  const d = useContext(DialogContext);
  if (!d) throw new Error("useDialogs needs <DialogProvider>");
  return d;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<Request | null>(null);
  const dialogs = useMemo<Dialogs>(
    () => ({
      confirm: (message, opts) =>
        new Promise((resolve) => setReq({ id: ++nextId, kind: "confirm", message, ok: opts?.ok ?? "OK", danger: opts?.danger ?? false, resolve })),
      prompt: (message, opts) =>
        new Promise((resolve) =>
          setReq({ id: ++nextId, kind: "prompt", message, ok: opts?.ok ?? "OK", initial: opts?.initial ?? opts?.options?.[0]?.value ?? "", options: opts?.options, resolve }),
        ),
      alert: (message) => new Promise((resolve) => setReq({ id: ++nextId, kind: "alert", message, resolve })),
    }),
    [],
  );
  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {req && <DialogView key={req.id} req={req} done={() => setReq(null)} />}
    </DialogContext.Provider>
  );
}

function DialogView({ req, done }: { req: Request; done: () => void }) {
  const [value, setValue] = useState(req.kind === "prompt" ? req.initial : "");
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement & HTMLSelectElement>(null);

  const close = useCallback(
    (ok: boolean) => {
      done();
      if (req.kind === "confirm") req.resolve(ok);
      else if (req.kind === "prompt") req.resolve(ok ? value : null);
      else req.resolve();
    },
    [done, req, value],
  );

  useEffect(() => {
    (inputRef.current ?? okRef.current)?.focus();
    inputRef.current?.select?.();
  }, []);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div
        className="dialog small-dialog"
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          if (e.key === "Escape") close(false);
          if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            close(true);
          }
        }}
      >
        <p className="dialog-message">{req.message}</p>
        {req.kind === "prompt" &&
          (req.options ? (
            <select ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)}>
              {req.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input ref={inputRef} className="dialog-input" value={value} onChange={(e) => setValue(e.target.value)} />
          ))}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {req.kind !== "alert" && <button onClick={() => close(false)}>Cancel</button>}
          <button
            ref={okRef}
            className={req.kind === "confirm" && req.danger ? "danger" : "primary"}
            onClick={() => close(true)}
          >
            {req.kind === "alert" ? "OK" : req.ok}
          </button>
        </div>
      </div>
    </div>
  );
}
