export type Workplace = "remote" | "hybrid" | "onsite" | "unknown";
export type GenerateMode = "both" | "cv" | "cover_letter";

export interface JobSummary {
  id: string;
  status: string;
  company: string;
  title: string;
  score: number | null;
  workplace: Workplace;
  city: string | null;
  officeDays: number | null;
  localOffice: boolean;
  localOfficeSource: "posting" | "inherited" | "manual" | null;
  preferred: boolean;
  sources: string[];
  applyUrl: string | null;
  pageWarning: boolean;
  guardErrors: string[];
  firstSeenAt: string;
  appliedAt: string | null;
  companyId: string | null;
  appliedAtCompany: number;
}

export interface Analysis {
  keywords: string[];
  strong_matches: string[];
  gaps: string[];
  summary?: string;
  experience?: { company: string; bullets: string[] }[];
  cover_letter?: string;
  changes_rationale?: { original: string; rewritten: string; why: string }[];
  guard?: { errors: string[]; warnings: string[] };
  render?: { scale: number; pages: number };
  edited_at?: string;
}

export interface JobDetail extends JobSummary {
  description: string;
  scoreReason: string | null;
  matches: string[];
  gaps: string[];
  postings: { source: string; url: string | null; location: string | null; postedAt: string | null }[];
  analysis: Analysis | null;
  coverLetter: string;
  hasPdf: boolean;
  parts: { cv: boolean; coverLetter: boolean };
  base: { summary: string; experience: { company: string; role: string; bullets: string[] }[] };
}

export interface AnalysisPair {
  job: JobSummary & { lastSeenAt: string; description: string };
  candidate: (JobSummary & { lastSeenAt: string; description: string }) | null;
  similarity: number | null;
}

export interface CompanyBoard {
  ats: "greenhouse" | "lever" | "ashby";
  slug: string;
  discoveredFrom: "posting" | "import";
  checkStatus: "unchecked" | "ok" | "not_found" | "error";
  checkError: string | null;
  checkedAt: string | null;
  openJobs: number | null;
  devJobs: number | null;
  fitJobs: number | null;
}

export interface CompanyRow {
  id: string;
  name: string;
  aliases: string[];
  followed: boolean;
  localOffice: boolean;
  localOfficeSource: "posting" | "manual" | null;
  notes: string | null;
  boards: CompanyBoard[];
  fitJobs: number;
  jobs: number;
  applied: number;
  bestScore: number | null;
  lastSeenAt: string | null;
}

export interface CollectorRow {
  source: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastCount: number | null;
  blockedUntil: string | null;
}

export interface ManualJobInput {
  description: string;
  url?: string;
  company?: string;
  title?: string;
  location?: string;
  workplace?: Workplace;
}

export class ApiError extends Error {
  constructor(message: string, readonly details: string[]) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-jobpipe": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: { error?: string; details?: string[] };
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(`HTTP ${res.status}: ${text.slice(0, 120) || res.statusText}. If the panel was updated, restart pnpm jobpipe review.`, []);
  }
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, data.details ?? []);
  return data as T;
}

export const api = {
  jobs: (view: "review" | "applied") => call<JobSummary[]>("GET", `/api/jobs${view === "applied" ? "?view=applied" : ""}`),
  job: (id: string) => call<JobDetail>("GET", `/api/jobs/${id}`),
  saveEdits: (id: string, edits: { summary?: string; bullets?: string[][]; coverLetter?: string }) =>
    call<{ warnings: string[]; scale: number | null; pageWarning: boolean }>("PUT", `/api/jobs/${id}/edits`, edits),
  generate: (id: string, mode: GenerateMode) => call<{ status: string; errors?: string[] }>("POST", `/api/jobs/${id}/generate`, { mode }),
  discard: (id: string, reason: string | null) => call("POST", `/api/jobs/${id}/discard`, { reason }),
  applied: (id: string) => call("POST", `/api/jobs/${id}/applied`),
  undoApplied: (id: string) => call("POST", `/api/jobs/${id}/undo-applied`),
  localOffice: (id: string, value: boolean | null) => call("PUT", `/api/jobs/${id}/local-office`, { value }),
  queue: () => call<{ threshold: number; jobs: (JobSummary & { aboveThreshold: boolean; manual: boolean })[] }>("GET", "/api/queue"),
  addJob: (job: ManualJobInput) =>
    call<{ jobId: string; created: boolean; existing?: "same_text" | "same_link"; status: string }>("POST", "/api/jobs/manual", job),
  analysis: () => call<AnalysisPair[]>("GET", "/api/analysis"),
  merge: (id: string) => call("POST", `/api/analysis/${id}/merge`),
  keep: (id: string) => call<{ ok: true; queued: boolean }>("POST", `/api/analysis/${id}/keep`),
  collectors: () => call<CollectorRow[]>("GET", "/api/collectors"),
  companies: () => call<CompanyRow[]>("GET", "/api/companies"),
  follow: (id: string, followed: boolean) => call("POST", `/api/companies/${id}/follow`, { followed }),
  renameCompany: (id: string, name: string) => call("POST", `/api/companies/${id}/rename`, { name }),
  mergeCompany: (id: string, into: string) => call("POST", `/api/companies/${id}/merge`, { into }),
  companyLocalOffice: (id: string, value: boolean | null) => call("PUT", `/api/companies/${id}/local-office`, { value }),
};
