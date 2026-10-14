import { useCallback, useEffect, useState } from "react";
import { api, type JobDetail, type JobSummary } from "./api.js";
import { Chips, Facts } from "./JobView.js";

type QueuedJob = JobSummary & { aboveThreshold: boolean };

/** Scored Jobs waiting for tailoring; Generate now runs it for one Job (uses quota). */
export function Queue({ onCount }: { onCount: (n: number) => void }) {
  const [jobs, setJobs] = useState<QueuedJob[]>([]);
  const [threshold, setThreshold] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const q = await api.queue();
    setJobs(q.jobs);
    setThreshold(q.threshold);
    onCount(q.jobs.length);
    setSelected((s) => (s && q.jobs.some((j) => j.id === s) ? s : (q.jobs[0]?.id ?? null)));
  }, [onCount]);
  useEffect(() => void reload(), [reload]);

  const firstBelow = jobs.findIndex((j) => !j.aboveThreshold);
  return (
    <main className="split">
      <aside className="list">
        <p className="muted pad small">
          <code>pnpm jobpipe generate</code> takes the jobs at or above {threshold}, in this order. The ones below only get generated if
          you ask.
        </p>
        {jobs.length === 0 && <p className="muted pad">The queue is empty.</p>}
        {jobs.map((j, i) => (
          <div key={j.id}>
            {i === firstBelow && <div className="divider">Below the threshold ({threshold})</div>}
            <button className={`item ${selected === j.id ? "selected" : ""}`} onClick={() => setSelected(j.id)}>
              <div className="item-top">
                <strong>{j.company}</strong>
                <span className="score">{j.score ?? "manual"}</span>
              </div>
              <div className="item-title">{j.title}</div>
              <div className="badges">
                {j.preferred && <span className="badge good">Preferred</span>}
                <span className="badge">{j.workplace}</span>
                {j.sources.map((s) => (
                  <span key={s} className="badge subtle">{s}</span>
                ))}
              </div>
            </button>
          </div>
        ))}
      </aside>
      <section className="detail">{selected ? <QueuedView key={selected} id={selected} onChanged={reload} /> : null}</section>
    </main>
  );
}

function QueuedView({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "good" | "bad"; text: string; details?: string[] } | null>(null);
  const load = useCallback(async () => setJob(await api.job(id)), [id]);
  useEffect(() => void load(), [load]);
  if (!job) return <p className="muted pad">Loading…</p>;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ kind: "bad", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const generate = () => {
    if (!confirm(`Generate the CV and cover letter for ${job.company} now? It uses subscription quota (~1 tailoring call).`)) return;
    void run("generate", async () => {
      const r = await api.regenerate(id);
      if (r.status === "generated") {
        alert("Generated — it is now in the Generated tab.");
        await onChanged();
      } else if (r.status === "quota_exhausted") setMessage({ kind: "bad", text: "Subscription quota exhausted — try again after the reset." });
      else {
        setMessage({ kind: "bad", text: "Blocked by the guard — it is now in the Generated tab with the errors.", details: r.errors });
        await onChanged();
      }
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
            Open job link
          </button>
          <button disabled={busy !== null} onClick={discard}>
            Discard
          </button>
          <button className="primary" disabled={busy !== null} onClick={generate}>
            {busy === "generate" ? "Generating… (~30s)" : "Generate now"}
          </button>
        </div>
      </div>
      {message && (
        <div className={`alert ${message.kind}`}>
          {message.text}
          {message.details && (
            <ul>
              {message.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Facts job={job} onChange={(v) => run("office", async () => { await api.localOffice(id, v); await load(); })} />
      <Chips label="Matches" items={job.matches} kind="good" />
      <Chips label="Gaps" items={job.gaps} kind="bad" />
      <p className="muted small">Matches and Gaps here are the deterministic ones from scoring; tailoring refines them.</p>
      <h3>Description</h3>
      <pre className="description">{job.description}</pre>
    </div>
  );
}
