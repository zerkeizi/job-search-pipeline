export type Workplace = "remote" | "hybrid" | "onsite" | "unknown";

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
}

export interface Analysis {
  keywords: string[];
  strong_matches: string[];
  gaps: string[];
  summary: string;
  experience: { company: string; bullets: string[] }[];
  cover_letter: string;
  changes_rationale: { original: string; rewritten: string; why: string }[];
  guard?: { errors: string[]; warnings: string[] };
  render?: { scale: number; pages: number };
  edited_at?: string;
}

export interface JobDetail extends JobSummary {
  description: string;
  scoreReason: string | null;
  postings: { source: string; url: string | null; location: string | null; postedAt: string | null }[];
  analysis: Analysis | null;
  coverLetter: string;
  hasPdf: boolean;
  base: { summary: string; experience: { company: string; role: string; bullets: string[] }[] };
}

export interface AnalysisPair {
  job: JobSummary & { lastSeenAt: string; description: string };
  candidate: (JobSummary & { lastSeenAt: string; description: string }) | null;
  similarity: number | null;
}

export interface CollectorRow {
  source: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastCount: number | null;
  blockedUntil: string | null;
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
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, data.details ?? []);
  return data as T;
}

export const api = {
  jobs: () => call<JobSummary[]>("GET", "/api/jobs"),
  job: (id: string) => call<JobDetail>("GET", `/api/jobs/${id}`),
  saveEdits: (id: string, edits: { summary: string; bullets: string[][]; coverLetter: string }) =>
    call<{ warnings: string[]; scale: number; pageWarning: boolean }>("PUT", `/api/jobs/${id}/edits`, edits),
  regenerate: (id: string) => call<{ status: string; errors?: string[] }>("POST", `/api/jobs/${id}/regenerate`),
  discard: (id: string, reason: string | null) => call("POST", `/api/jobs/${id}/discard`, { reason }),
  applied: (id: string) => call("POST", `/api/jobs/${id}/applied`),
  localOffice: (id: string, value: boolean | null) => call("PUT", `/api/jobs/${id}/local-office`, { value }),
  analysis: () => call<AnalysisPair[]>("GET", "/api/analysis"),
  merge: (id: string) => call("POST", `/api/analysis/${id}/merge`),
  keep: (id: string) => call("POST", `/api/analysis/${id}/keep`),
  collectors: () => call<CollectorRow[]>("GET", "/api/collectors"),
};
