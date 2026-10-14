import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CompanyBoard, type CompanyRow } from "./api.js";

const BOARD_URL: Record<CompanyBoard["ats"], (slug: string) => string> = {
  greenhouse: (s) => `https://boards.greenhouse.io/${s}`,
  lever: (s) => `https://jobs.lever.co/${s}`,
  ashby: (s) => `https://jobs.ashbyhq.com/${s}`,
};

/** The company catalog: decide which companies to follow (their boards get collected). */
export function Companies() {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"boards" | "followed" | "all">("boards");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setRows(await api.companies()), []);
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

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return rows.filter(
      (c) =>
        (view === "all" || (view === "followed" ? c.followed : c.boards.length > 0 || c.followed)) &&
        (!f || c.name.toLowerCase().includes(f) || c.aliases.some((a) => a.includes(f)) || c.boards.some((b) => b.slug.includes(f))),
    );
  }, [rows, filter, view]);

  const rename = (c: CompanyRow) => {
    const name = prompt("New name:", c.name);
    if (name && name.trim() !== c.name) void act(() => api.renameCompany(c.id, name));
  };
  const merge = (c: CompanyRow) => {
    const target = prompt(`Merge "${c.name}" into which company? Type its exact name:`);
    if (!target) return;
    const into = rows.find((r) => r.name.toLowerCase() === target.trim().toLowerCase() && r.id !== c.id);
    if (!into) return setError(`No other company named "${target}".`);
    if (confirm(`"${c.name}" and "${into.name}" are the same employer? Its names, boards and jobs move to "${into.name}".`))
      void act(() => api.mergeCompany(c.id, into.id));
  };

  return (
    <main className="pad stack">
      <div className="row spread wrap">
        <div className="row">
          <select value={view} onChange={(e) => setView(e.target.value as typeof view)}>
            <option value="boards">With boards</option>
            <option value="followed">Followed</option>
            <option value="all">All companies</option>
          </select>
          <input className="search" placeholder="Search name or slug" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <span className="muted small">
          Boards come from collected job links and <code>pnpm jobpipe companies import</code>; counts from{" "}
          <code>pnpm jobpipe companies check</code>. Following a company collects its boards.
        </span>
      </div>
      {error && <div className="alert bad">{error}</div>}
      {visible.length === 0 && <p className="muted">No companies here yet.</p>}
      {visible.length > 0 && (
        <table className="companies">
          <thead>
            <tr>
              <th>Company</th>
              <th>Boards · fitting / dev / open jobs</th>
              <th>Collected</th>
              <th>Local Office</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} className={c.followed ? "followed" : ""}>
                <td>
                  <strong>{c.name}</strong>
                  {c.aliases.length > 0 && <div className="muted small">aka {c.aliases.join(", ")}</div>}
                </td>
                <td>
                  {c.boards.length === 0 && <span className="muted">–</span>}
                  {c.boards.map((b) => (
                    <div key={`${b.ats}:${b.slug}`} className="small">
                      <a href={BOARD_URL[b.ats](b.slug)} target="_blank" rel="noopener noreferrer">
                        {b.ats}:{b.slug}
                      </a>{" "}
                      {b.checkStatus === "ok" ? (
                        <span>
                          · <strong>{b.fitJobs}</strong> / {b.devJobs} / {b.openJobs}
                        </span>
                      ) : (
                        <span className={`badge ${b.checkStatus === "not_found" || b.checkStatus === "error" ? "bad" : "subtle"}`} title={b.checkError ?? ""}>
                          {b.checkStatus.replace("_", " ")}
                        </span>
                      )}
                    </div>
                  ))}
                </td>
                <td className="small">
                  {c.jobs > 0 ? `${c.jobs} jobs` : "–"}
                  {c.applied > 0 && <div>applied {c.applied}×</div>}
                  {c.bestScore !== null && <div className="muted">best score {c.bestScore}</div>}
                </td>
                <td className="small">
                  <select
                    value={c.localOfficeSource === "manual" ? String(c.localOffice) : "auto"}
                    onChange={(e) => act(() => api.companyLocalOffice(c.id, e.target.value === "auto" ? null : e.target.value === "true"))}
                  >
                    <option value="auto">{c.localOfficeSource === "posting" ? "yes (from a job)" : "no (automatic)"}</option>
                    <option value="true">yes (manual)</option>
                    <option value="false">no (manual)</option>
                  </select>
                </td>
                <td>
                  <div className="row">
                    <button className={c.followed ? "" : "primary"} disabled={!c.followed && c.boards.every((b) => b.checkStatus === "not_found")} onClick={() => act(() => api.follow(c.id, !c.followed))}>
                      {c.followed ? "Unfollow" : "Follow"}
                    </button>
                    <button onClick={() => rename(c)}>Rename</button>
                    <button onClick={() => merge(c)}>Merge…</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
