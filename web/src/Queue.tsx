import { useCallback, useEffect, useState } from "react";
import { api, type GenerateMode, type JobDetail, type JobSummary } from "./api.js";
import { useDialogs } from "./dialogs.js";
import { describeMode, GenerateMenu } from "./GenerateMenu.js";
import { Chips, Facts } from "./JobView.js";

type QueuedJob = JobSummary & { aboveThreshold: boolean; manual: boolean };

/**
 * Scored Jobs waiting for tailoring. Generate now runs one Job; ticking several and
 * "Generate selected" runs them one after the other (each uses quota). `version` changes
 * when a Job is added elsewhere (the Add job dialog).
 */
export function Queue({ onCount, version }: { onCount: (n: number) => void; version: number }) {
  const [jobs, setJobs] = useState<QueuedJob[]>([]);
  const [threshold, setThreshold] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<{ done: number; total: number; current: string } | null>(null);
  const [batchResult, setBatchResult] = useState<{ kind: "good" | "bad"; text: string; details: string[] } | null>(null);
  const dialogs = useDialogs();

  const reload = useCallback(async () => {
    const q = await api.queue();
    setJobs(q.jobs);
    setThreshold(q.threshold);
    onCount(q.jobs.length);
    setSelected((s) => (s && q.jobs.some((j) => j.id === s) ? s : (q.jobs[0]?.id ?? null)));
    setChecked((c) => new Set([...c].filter((id) => q.jobs.some((j) => j.id === id))));
  }, [onCount]);
  useEffect(() => void reload(), [reload, version]);

  const toggle = (id: string) =>
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** One Job after the other, like `jobpipe generate`; stops when the subscription quota runs out. */
  const generateSelected = async (mode: GenerateMode) => {
    const list = jobs.filter((j) => checked.has(j.id));
    const ok = await dialogs.confirm(
      `Generate ${describeMode(mode)} for ${list.length} job(s)? One tailoring call each (~30s), using subscription quota.`,
      { ok: `Generate ${list.length}` },
    );
    if (!ok) return;
    setBatchResult(null);
    const failed: string[] = [];
    let generated = 0;
    let stopped = false;
    for (const [i, j] of list.entries()) {
      setBatch({ done: i, total: list.length, current: j.company });
      try {
        const r = await api.generate(j.id, mode);
        if (r.status === "generated") generated++;
        else if (r.status === "quota_exhausted") {
          stopped = true;
          break;
        } else failed.push(`${j.company}: blocked by the guard${r.errors?.length ? ` (${r.errors[0]})` : ""}`);
      } catch (e) {
        failed.push(`${j.company}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBatch(null);
    setChecked(new Set());
    setBatchResult({
      kind: failed.length || stopped ? "bad" : "good",
      text:
        `Generated ${generated} of ${list.length} — they are in the Generated tab.` +
        (stopped ? " Stopped: subscription quota exhausted; the rest stay here." : ""),
      details: failed,
    });
    await reload();
  };

  const manualIds = jobs.filter((j) => j.manual).map((j) => j.id);
  const firstBelow = jobs.findIndex((j) => !j.aboveThreshold);
  return (
    <main className="split">
      <aside className="list">
        <p className="muted pad small">
          <code>pnpm jobpipe generate</code> takes manual jobs and those at or above {threshold}, in this order. The ones below only get
          generated if you ask.
        </p>
        <div className="filters">
          <button disabled={batch !== null || manualIds.length === 0} onClick={() => setChecked(new Set(manualIds))}>
            Select manual
          </button>
          <button disabled={batch !== null || checked.size === 0} onClick={() => setChecked(new Set())}>
            Clear
          </button>
          <GenerateMenu label={`Generate selected (${checked.size})`} primary busy={batch !== null} disabled={checked.size === 0} onPick={(m) => void generateSelected(m)} />
        </div>
        {batch && (
          <div className="alert warn">
            Generating {batch.done + 1} of {batch.total}: {batch.current}… keep this tab open.
          </div>
        )}
        {batchResult && (
          <div className={`alert ${batchResult.kind}`}>
            {batchResult.text}
            {batchResult.details.length > 0 && (
              <ul>
                {batchResult.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {jobs.length === 0 && <p className="muted pad">The queue is empty.</p>}
        {jobs.map((j, i) => (
          <div key={j.id}>
            {i === firstBelow && <div className="divider">Below the threshold ({threshold})</div>}
            <button className={`item ${selected === j.id ? "selected" : ""}`} onClick={() => setSelected(j.id)}>
              <div className="item-top">
                <span className="row">
                  <input
                    type="checkbox"
                    checked={checked.has(j.id)}
                    disabled={batch !== null}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(j.id)}
                  />
                  <strong>{j.company}</strong>
                </span>
                <span className="score">{j.score ?? "manual"}</span>
              </div>
              <div className="item-title">{j.title}</div>
              <div className="badges">
                {j.preferred && <span className="badge good">Preferred</span>}
                <span className="badge">{j.workplace}</span>
                {j.sources.map((s) => (
                  <span key={s} className="badge subtle">
                    {s}
                  </span>
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
  const dialogs = useDialogs();
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

  const generate = async (mode: GenerateMode) => {
    const ok = await dialogs.confirm(`Generate ${describeMode(mode)} for ${job.company} now? It uses subscription quota (one tailoring call).`, {
      ok: "Generate",
    });
    if (!ok) return;
    void run("generate", async () => {
      const r = await api.generate(id, mode);
      if (r.status === "generated") {
        await dialogs.alert(`Generated ${describeMode(mode)} — it is now in the Generated tab.`);
        await onChanged();
      } else if (r.status === "quota_exhausted")
        setMessage({ kind: "bad", text: "Subscription quota exhausted — try again after the reset." });
      else {
        setMessage({ kind: "bad", text: "Blocked by the guard — it is now in the Generated tab with the errors.", details: r.errors });
        await onChanged();
      }
    });
  };

  const applied = async () => {
    if (!(await dialogs.confirm(`Mark ${job.company} as applied without generating anything here?`, { ok: "Mark as applied" }))) return;
    void run("applied", async () => {
      await api.applied(id);
      await dialogs.alert("Marked as applied — it is now in the Applied tab.");
      await onChanged();
    });
  };

  const discard = async () => {
    const reason = await dialogs.prompt("Discard this job? Optional reason:", { ok: "Discard" });
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
          <button disabled={busy !== null} onClick={applied}>
            Mark as applied
          </button>
          <GenerateMenu label="Generate now" primary busy={busy === "generate"} onPick={generate} />
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
      <Facts
        job={job}
        onChange={(v) =>
          run("office", async () => {
            await api.localOffice(id, v);
            await load();
          })
        }
      />
      <Chips label="Matches" items={job.matches} kind="good" />
      <Chips label="Gaps" items={job.gaps} kind="bad" />
      <p className="muted small">Matches and Gaps here are the deterministic ones from scoring; tailoring refines them.</p>
      <h3>Description</h3>
      <pre className="description">{job.description}</pre>
    </div>
  );
}
