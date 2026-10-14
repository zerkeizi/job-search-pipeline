import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type JobDetail } from "./api.js";

interface Draft {
  summary: string;
  bullets: string[][];
  coverLetter: string;
}

const draftOf = (job: JobDetail): Draft => ({
  summary: job.analysis?.summary ?? job.base.summary,
  bullets: job.base.experience.map((e, i) => job.analysis?.experience[i]?.bullets ?? e.bullets),
  coverLetter: job.coverLetter,
});

export function JobView({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "good" | "bad" | "warn"; text: string; details?: string[] } | null>(null);
  const [pdfVersion, setPdfVersion] = useState(0);

  const load = useCallback(async () => {
    const j = await api.job(id);
    setJob(j);
    setDraft(draftOf(j));
  }, [id]);
  useEffect(() => void load(), [load]);

  if (!job || !draft) return <p className="muted pad">Loading…</p>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(job));

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage({ kind: "good", text: done });
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof Error ? e.message : String(e), details: e instanceof ApiError ? e.details : [] });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const r = await api.saveEdits(id, draft);
      await load();
      setPdfVersion((v) => v + 1);
      await onChanged();
      setMessage({
        kind: r.warnings.length || r.pageWarning ? "warn" : "good",
        text: `Saved and re-rendered${r.scale < 1 ? ` (scaled to ${r.scale})` : ""}${r.pageWarning ? " — still more than 1 page" : ""}.`,
        details: r.warnings,
      });
    });

  const regenerate = () => {
    if (!confirm("Regenerate this CV and cover letter? Your edits will be lost, and it uses subscription quota.")) return;
    void run("regenerate", async () => {
      const r = await api.regenerate(id);
      await load();
      setPdfVersion((v) => v + 1);
      await onChanged();
      if (r.status === "generated") setMessage({ kind: "good", text: "Regenerated." });
      else if (r.status === "quota_exhausted") setMessage({ kind: "bad", text: "Subscription quota exhausted — try again after the reset." });
      else setMessage({ kind: "bad", text: "Regeneration was blocked by the guard.", details: r.errors });
    });
  };

  const discard = () => {
    const reason = prompt("Discard this job? Optional reason:");
    if (reason === null) return;
    void run("discard", async () => {
      await api.discard(id, reason);
      await onChanged();
    });
  };

  const applied = () => {
    if (!confirm("Mark as applied? This is the end of the pipeline for this job.")) return;
    void run("applied", async () => {
      await api.applied(id);
      await onChanged();
    });
  };

  const a = job.analysis;
  const rationale = (rewritten: string) => a?.changes_rationale.find((r) => r.rewritten.trim() === rewritten.trim());
  const errors = job.status === "blocked" ? job.guardErrors : [];
  const warnings = a?.guard?.warnings ?? [];

  return (
    <div className="job">
      <div className="toolbar">
        <div>
          <h2>
            {job.company} — {job.title}
          </h2>
          <div className="muted">
            score {job.score ?? "manual"}
            {job.scoreReason ? ` · ${job.scoreReason}` : ""}
          </div>
        </div>
        <div className="row wrap">
          <button disabled={!job.applyUrl} onClick={() => job.applyUrl && window.open(job.applyUrl, "_blank", "noopener")}>
            Open apply link
          </button>
          <button onClick={() => run("copy", () => navigator.clipboard.writeText(draft.coverLetter), "Cover letter copied.")}>
            Copy cover letter
          </button>
          <button disabled={busy !== null} onClick={regenerate}>
            {busy === "regenerate" ? "Regenerating…" : "Regenerate"}
          </button>
          <button disabled={busy !== null} onClick={discard}>
            Discard
          </button>
          <button className="primary" disabled={busy !== null} onClick={applied}>
            Mark as applied
          </button>
        </div>
      </div>

      {message && (
        <div className={`alert ${message.kind}`}>
          {message.text}
          {message.details && message.details.length > 0 && (
            <ul>
              {message.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {errors.length > 0 && (
        <div className="alert bad">
          Blocked by the guard:
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {job.pageWarning && <div className="alert warn">The CV does not fit on one page even at the minimum scale — shorten it below.</div>}

      <div className="columns">
        <div className="col">
          <Facts job={job} onChange={(v) => run("office", async () => { await api.localOffice(id, v); await load(); await onChanged(); })} />
          <h3>Description</h3>
          <pre className="description">{job.description}</pre>
        </div>

        <div className="col">
          {a && (
            <>
              <Chips label="Keywords" items={a.keywords} />
              <Chips label="Matches" items={a.strong_matches} kind="good" />
              <Chips label="Gaps" items={a.gaps} kind="bad" />
              {warnings.length > 0 && (
                <div className="alert warn">
                  Guard warnings (not blocking):
                  <ul>
                    {warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {job.hasPdf && (
            <>
              <h3>CV preview{a?.render && a.render.scale < 1 ? ` (scale ${a.render.scale})` : ""}</h3>
              <iframe className="pdf" title="CV" src={`/api/jobs/${id}/cv.pdf?v=${pdfVersion}`} />
            </>
          )}

          <h3>Summary</h3>
          <textarea rows={5} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          <Original text={job.base.summary} why={rationale(draft.summary)?.why} />

          {job.base.experience.map((exp, ci) => {
            const used = new Set(draft.bullets[ci]!.map((b) => rationale(b)?.original.trim() ?? b.trim()));
            const unused = exp.bullets.filter((b) => !used.has(b.trim()));
            return (
              <div key={exp.company} className="company">
                <h3>
                  {exp.company} <span className="muted">· {exp.role}</span>
                </h3>
                {draft.bullets[ci]!.map((b, bi) => {
                  const r = rationale(b);
                  return (
                    <div key={bi} className="bullet">
                      <div className="row">
                        <textarea
                          rows={2}
                          value={b}
                          onChange={(e) => {
                            const bullets = draft.bullets.map((list, i) => (i === ci ? list.map((x, j) => (j === bi ? e.target.value : x)) : list));
                            setDraft({ ...draft, bullets });
                          }}
                        />
                        <button
                          className="ghost"
                          title="Remove bullet"
                          onClick={() => setDraft({ ...draft, bullets: draft.bullets.map((list, i) => (i === ci ? list.filter((_, j) => j !== bi) : list)) })}
                        >
                          ×
                        </button>
                      </div>
                      {r && r.original.trim() !== b.trim() && <Original text={r.original} why={r.why} />}
                    </div>
                  );
                })}
                {unused.length > 0 && (
                  <details>
                    <summary className="muted">{unused.length} Base CV bullet(s) not used — click to add back</summary>
                    {unused.map((u) => (
                      <button
                        key={u}
                        className="unused"
                        onClick={() => setDraft({ ...draft, bullets: draft.bullets.map((list, i) => (i === ci ? [...list, u] : list)) })}
                      >
                        + {u}
                      </button>
                    ))}
                  </details>
                )}
              </div>
            );
          })}

          <h3>Cover letter</h3>
          <textarea rows={16} value={draft.coverLetter} onChange={(e) => setDraft({ ...draft, coverLetter: e.target.value })} />

          <div className="row sticky">
            <button className="primary" disabled={!dirty || busy !== null || !a} onClick={save}>
              {busy === "save" ? "Checking and rendering…" : "Save edits (guard + re-render)"}
            </button>
            <button disabled={!dirty || busy !== null} onClick={() => setDraft(draftOf(job))}>
              Undo changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Facts({ job, onChange }: { job: JobDetail; onChange: (v: boolean | null) => void }) {
  const value = job.localOfficeSource === "manual" ? String(job.localOffice) : "auto";
  return (
    <div className="facts">
      <span>
        <strong>Workplace</strong> {job.workplace}
      </span>
      <span>
        <strong>City</strong> {job.city ?? "–"}
      </span>
      <span>
        <strong>Office days</strong> {job.officeDays ?? "–"}
      </span>
      <span>
        <strong>Local Office</strong> {job.localOffice ? "yes" : "no"}
        {job.localOfficeSource ? ` (${job.localOfficeSource})` : ""}{" "}
        <select value={value} onChange={(e) => onChange(e.target.value === "auto" ? null : e.target.value === "true")}>
          <option value="auto">automatic</option>
          <option value="true">yes (manual)</option>
          <option value="false">no (manual)</option>
        </select>
      </span>
      <span>
        <strong>Sources</strong>{" "}
        {job.postings.map((p, i) => (
          <a key={i} href={p.url ?? undefined} target="_blank" rel="noopener noreferrer">
            {p.source}
            {i < job.postings.length - 1 ? ", " : ""}
          </a>
        ))}
      </span>
    </div>
  );
}

function Chips({ label, items, kind }: { label: string; items: string[]; kind?: "good" | "bad" }) {
  if (items.length === 0) return null;
  return (
    <div className="chips">
      <strong>{label}</strong>
      {items.map((i) => (
        <span key={i} className={`badge ${kind ?? ""}`}>
          {i}
        </span>
      ))}
    </div>
  );
}

function Original({ text, why }: { text: string; why?: string }) {
  return (
    <div className="original">
      <span className="muted">Base CV:</span> {text}
      {why && <div className="why">Why: {why}</div>}
    </div>
  );
}
