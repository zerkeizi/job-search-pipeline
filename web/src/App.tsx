import { useCallback, useEffect, useState } from "react";
import { type AnalysisPair, api, type CollectorRow, type JobSummary } from "./api.js";
import { JobView } from "./JobView.js";

type Tab = "generated" | "analysis" | "collectors";

export function App() {
  const [tab, setTab] = useState<Tab>("generated");
  const [counts, setCounts] = useState({ generated: 0, analysis: 0 });
  return (
    <div className="app">
      <header>
        <h1>Job Pipeline</h1>
        <nav>
          <button className={tab === "generated" ? "active" : ""} onClick={() => setTab("generated")}>
            Generated <span className="count">{counts.generated}</span>
          </button>
          <button className={tab === "analysis" ? "active" : ""} onClick={() => setTab("analysis")}>
            Analysis <span className="count">{counts.analysis}</span>
          </button>
          <button className={tab === "collectors" ? "active" : ""} onClick={() => setTab("collectors")}>
            Collectors
          </button>
        </nav>
      </header>
      {tab === "generated" && <Generated onCount={(n) => setCounts((c) => ({ ...c, generated: n }))} />}
      {tab === "analysis" && <AnalysisTab onCount={(n) => setCounts((c) => ({ ...c, analysis: n }))} />}
      {tab === "collectors" && <Collectors />}
    </div>
  );
}

function Generated({ onCount }: { onCount: (n: number) => void }) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [preferredOnly, setPreferredOnly] = useState(false);

  const reload = useCallback(async () => {
    const list = await api.jobs();
    setJobs(list);
    onCount(list.length);
    setSelected((s) => (s && list.some((j) => j.id === s) ? s : (list[0]?.id ?? null)));
  }, [onCount]);
  useEffect(() => void reload(), [reload]);

  const sources = [...new Set(jobs.flatMap((j) => j.sources))].sort();
  const visible = jobs.filter((j) => (!source || j.sources.includes(source)) && (!preferredOnly || j.preferred));

  return (
    <main className="split">
      <aside className="list">
        <div className="filters">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <label>
            <input type="checkbox" checked={preferredOnly} onChange={(e) => setPreferredOnly(e.target.checked)} /> Preferred only
          </label>
        </div>
        {visible.length === 0 && <p className="muted pad">Nothing to review. Run <code>pnpm jobpipe run</code>.</p>}
        {visible.map((j) => (
          <button key={j.id} className={`item ${selected === j.id ? "selected" : ""}`} onClick={() => setSelected(j.id)}>
            <div className="item-top">
              <strong>{j.company}</strong>
              <span className="score">{j.score ?? "manual"}</span>
            </div>
            <div className="item-title">{j.title}</div>
            <div className="badges">
              {j.preferred && <span className="badge good">Preferred</span>}
              {j.status === "blocked" && <span className="badge bad">Blocked</span>}
              {j.pageWarning && <span className="badge warn">&gt; 1 page</span>}
              <span className="badge">{j.workplace}</span>
              {j.sources.map((s) => (
                <span key={s} className="badge subtle">{s}</span>
              ))}
            </div>
          </button>
        ))}
      </aside>
      <section className="detail">{selected ? <JobView key={selected} id={selected} onChanged={reload} /> : null}</section>
    </main>
  );
}

function AnalysisTab({ onCount }: { onCount: (n: number) => void }) {
  const [pairs, setPairs] = useState<AnalysisPair[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const list = await api.analysis();
    setPairs(list);
    onCount(list.length);
  }, [onCount]);
  useEffect(() => void reload(), [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (pairs.length === 0) return <p className="muted pad">No possible duplicates waiting for a decision.</p>;
  return (
    <main className="pad stack">
      {error && <div className="alert bad">{error}</div>}
      {pairs.map(({ job, candidate, similarity }) => (
        <article key={job.id} className="card">
          <div className="row spread">
            <h3>
              Possible duplicate — description similarity {similarity === null ? "?" : `${Math.round(similarity * 100)}%`}
            </h3>
            <div className="row">
              <button onClick={() => act(() => api.merge(job.id))} disabled={!candidate}>
                Merge
              </button>
              <button onClick={() => act(() => api.keep(job.id))}>Keep separate</button>
            </div>
          </div>
          <div className="columns">
            {[
              ["New job", job],
              ["Existing job", candidate],
            ].map(([label, j]) =>
              j && typeof j === "object" ? (
                <div key={label as string}>
                  <h4>{label as string}</h4>
                  <p>
                    <strong>{j.company}</strong> — {j.title}
                    <br />
                    <span className="muted">
                      score {j.score ?? "–"} · {j.status} · first seen {j.firstSeenAt.slice(0, 10)} · last seen {j.lastSeenAt.slice(0, 10)} ·{" "}
                      {j.sources.join(", ")}
                    </span>
                  </p>
                  <pre className="description short">{j.description}</pre>
                </div>
              ) : (
                <p key={label as string} className="muted">The existing job is gone.</p>
              ),
            )}
          </div>
        </article>
      ))}
    </main>
  );
}

function Collectors() {
  const [rows, setRows] = useState<CollectorRow[]>([]);
  useEffect(() => void api.collectors().then(setRows), []);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "–");
  return (
    <main className="pad">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Enabled</th>
            <th>Last successful collection</th>
            <th>Postings</th>
            <th>Blocked until</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source}>
              <td>{r.source}</td>
              <td>{r.enabled ? "yes" : <span className="muted">no</span>}</td>
              <td>{when(r.lastSuccessAt)}</td>
              <td>{r.lastCount ?? "–"}</td>
              <td>{r.blockedUntil ? <span className="badge bad">{when(r.blockedUntil)}</span> : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
