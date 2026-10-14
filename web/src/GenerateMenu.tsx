import { useEffect, useRef, useState } from "react";
import type { GenerateMode } from "./api.js";

const ITEMS: { mode: GenerateMode; label: string }[] = [
  { mode: "both", label: "CV + cover letter" },
  { mode: "cv", label: "CV only" },
  { mode: "cover_letter", label: "Cover letter only" },
];

/** A button with a small menu to generate both documents or just one (each call uses quota). */
export function GenerateMenu({
  label,
  busy,
  primary,
  existing,
  onPick,
}: {
  label: string;
  busy: boolean;
  primary?: boolean;
  /** Parts the Job already has: regenerating them replaces my edits. */
  existing?: { cv: boolean; coverLetter: boolean };
  onPick: (mode: GenerateMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const replaces = (mode: GenerateMode) =>
    existing && ((mode !== "cover_letter" && existing.cv) || (mode !== "cv" && existing.coverLetter));
  return (
    <div className="menu" ref={ref}>
      <button className={primary ? "primary" : ""} disabled={busy} onClick={() => setOpen((o) => !o)}>
        {busy ? "Generating… (~30s)" : `${label} ▾`}
      </button>
      {open && (
        <div className="menu-items">
          {ITEMS.map((i) => (
            <button
              key={i.mode}
              onClick={() => {
                setOpen(false);
                onPick(i.mode);
              }}
            >
              {i.label}
              {replaces(i.mode) && <span className="muted small"> · replaces edits</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const describeMode = (mode: GenerateMode) => ITEMS.find((i) => i.mode === mode)!.label.toLowerCase();
