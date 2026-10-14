import { useState } from "react";
import { ApiError, api, type ManualJobInput, type Workplace } from "./api.js";

const EMPTY: Required<ManualJobInput> = { title: "", company: "", url: "", location: "", workplace: "unknown", description: "" };

/**
 * "Add job": a job I found myself goes to the Queue (scored for matches and Gaps, no LLM call).
 * "Save and add another" keeps the dialog open, so I can add many and generate them at the end.
 */
export function AddJob({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "good" | "bad" | "warn"; text: string } | null>(null);
  const [added, setAdded] = useState(0);
  const set = (k: keyof ManualJobInput) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const save = async (another: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.addJob({
        description: form.description,
        ...(form.title.trim() ? { title: form.title } : {}),
        ...(form.company.trim() ? { company: form.company } : {}),
        ...(form.url.trim() ? { url: form.url } : {}),
        ...(form.location.trim() ? { location: form.location } : {}),
        workplace: form.workplace,
      });
      onAdded();
      const name = form.company.trim() || "The job";
      if (r.existing === "same_text") setMessage({ kind: "warn", text: `This text was already added (status: ${r.status}). Nothing new was created.` });
      else if (r.existing === "same_link")
        setMessage({
          kind: "warn",
          text:
            r.status === "scored"
              ? `That link was already collected — the existing job is now in the Queue.`
              : `That link was already collected and the job is ${r.status}; your text was attached to it.`,
        });
      else {
        setAdded((n) => n + 1);
        if (!another) return onClose();
        setMessage({ kind: "good", text: `${name} added to the Queue.` });
      }
      if (another || r.existing) setForm(r.existing ? form : EMPTY);
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof ApiError || e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-label="Add job">
        <div className="row spread">
          <h2>Add job</h2>
          {added > 0 && <span className="muted small">{added} added this session</span>}
        </div>
        <p className="muted small">
          It goes to the Queue with its score, matches and Gaps (no quota used). Company and title are optional — when empty, the
          tailoring reads them from the description.
        </p>
        <div className="form-grid">
          <label>
            Title
            <input value={form.title} onChange={set("title")} placeholder="Senior Full Stack Developer" />
          </label>
          <label>
            Company
            <input value={form.company} onChange={set("company")} placeholder="Acme" />
          </label>
          <label className="wide">
            Apply link
            <input value={form.url} onChange={set("url")} placeholder="https://…" />
          </label>
          <label>
            Location
            <input value={form.location} onChange={set("location")} placeholder="Porto Alegre, RS" />
          </label>
          <label>
            Workplace
            <select value={form.workplace} onChange={(e) => setForm({ ...form, workplace: e.target.value as Workplace })}>
              <option value="unknown">unknown</option>
              <option value="remote">remote</option>
              <option value="hybrid">hybrid</option>
              <option value="onsite">onsite</option>
            </select>
          </label>
          <label className="wide">
            Description *
            <textarea rows={14} value={form.description} onChange={set("description")} placeholder="Paste the full job description" />
          </label>
        </div>
        {message && <div className={`alert ${message.kind}`}>{message.text}</div>}
        <div className="row spread">
          <button disabled={busy} onClick={onClose}>
            Close
          </button>
          <div className="row">
            <button disabled={busy || !form.description.trim()} onClick={() => save(true)}>
              Save and add another
            </button>
            <button className="primary" disabled={busy || !form.description.trim()} onClick={() => save(false)}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
