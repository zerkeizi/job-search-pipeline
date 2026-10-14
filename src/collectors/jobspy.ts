import { spawn } from "node:child_process";
import { z } from "zod";
import { isBlocked, logCollector, markBlocked, markSuccess, windowHours } from "../collector-state.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { ingest, type PostingIn } from "../ingest.js";
import type { Workplace } from "../status.js";

export const JOBSPY_SITES = ["linkedin", "indeed", "glassdoor", "google"] as const;
export type JobspySite = (typeof JOBSPY_SITES)[number];

/** Input of the Python sidecar (CLAUDE.md, "Contrato do sidecar"). No credentials, ever. */
export interface SidecarInput {
  sites: JobspySite[];
  search_term: string;
  google_search_term: string;
  location: string;
  country_indeed: string;
  is_remote: boolean;
  hours_old: number;
  results_wanted: number;
  fetch_description: boolean;
  description_format: "markdown";
}

const nullableString = z.string().nullish().transform((v) => v ?? null);
const nullableNumber = z.number().nullish().transform((v) => v ?? null);

/** One JobSpy row as the sidecar emits it (extra columns are ignored). */
export const jobspyRecordSchema = z.looseObject({
  id: z.string().min(1),
  site: z.enum(JOBSPY_SITES),
  job_url: z.string().min(1),
  job_url_direct: nullableString,
  title: z.string().min(1),
  company: nullableString,
  location: nullableString,
  date_posted: nullableString,
  interval: nullableString,
  min_amount: nullableNumber,
  max_amount: nullableNumber,
  currency: nullableString,
  is_remote: z.boolean().nullish(),
  work_from_home_type: nullableString,
  description: nullableString,
});

export type JobspyRecord = z.infer<typeof jobspyRecordSchema>;

export function toPosting(r: JobspyRecord): PostingIn | null {
  if (!r.description?.trim()) return null;
  const wfh = r.work_from_home_type?.toLowerCase() ?? "";
  const workplace: Workplace = r.is_remote || wfh.includes("remote") ? "remote" : wfh.includes("hybrid") ? "hybrid" : "unknown";
  return {
    source: r.site,
    externalId: r.id,
    url: r.job_url,
    applyUrl: r.job_url_direct ?? r.job_url,
    company: r.company ?? "Unknown company",
    title: r.title,
    location: r.location,
    workplace,
    salaryMin: r.min_amount,
    salaryMax: r.max_amount,
    salaryCurrency: r.currency,
    salaryInterval: r.interval,
    description: r.description,
    postedAt: r.date_posted,
  };
}

export interface SidecarRunner {
  command: string;
  args: string[];
  cwd?: string;
}

/** Run from the sidecar's own directory so `python -m jobspy_sidecar` finds the package. */
export const defaultSidecar: SidecarRunner = {
  command: "uv",
  args: ["run", "--project", ".", "python", "-m", "jobspy_sidecar"],
  cwd: "sidecar/jobspy",
};

export interface SidecarResult {
  exitCode: number | null;
  records: unknown[];
  blocked: JobspySite[];
  /** Sites that errored (not blocked) while others succeeded: not marked as a successful collection. */
  failed: JobspySite[];
  error?: string;
}

/** Runs the sidecar once (no shell), with a hard timeout. Exit 0 = ok, 2 = some sites blocked, 1 = error. */
export async function runSidecar(input: SidecarInput, runner: SidecarRunner, timeoutMs: number): Promise<SidecarResult> {
  const child = spawn(runner.command, runner.args, { cwd: runner.cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify(input));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  if (timedOut) return { exitCode, records: [], blocked: [], failed: [], error: `timed out after ${timeoutMs / 1000}s` };

  // The last JSON line on stderr names blocked and failed sites.
  const statusLine = stderr.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  let status: unknown = null;
  try {
    status = statusLine ? JSON.parse(statusLine) : null;
  } catch {
    status = null;
  }
  const parsed = z
    .object({ blocked: z.array(z.enum(JOBSPY_SITES)), failed: z.array(z.enum(JOBSPY_SITES)).default([]) })
    .safeParse(status);
  const inInput = (list: JobspySite[]) => list.filter((s) => input.sites.includes(s));
  const blocked = exitCode === 2 ? (parsed.success ? inInput(parsed.data.blocked) : [...input.sites]) : [];
  const failed = parsed.success ? inInput(parsed.data.failed) : [];
  if (exitCode !== 0 && exitCode !== 2) {
    return { exitCode, records: [], blocked, failed, error: stderr.trim().split("\n").slice(-3).join(" | ") || `exit ${exitCode}` };
  }
  let records: unknown;
  try {
    records = JSON.parse(stdout || "[]");
  } catch {
    return { exitCode, records: [], blocked, failed, error: "stdout is not JSON" };
  }
  if (!Array.isArray(records)) return { exitCode, records: [], blocked, failed, error: "stdout is not a JSON array" };
  return { exitCode, records, blocked, failed };
}

export interface CollectOptions {
  sites?: JobspySite[];
  force?: boolean;
  runner?: SidecarRunner;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logDir?: string;
}

export interface CollectSummary {
  created: number;
  linked: number;
  flagged: number;
  seenAgain: number;
  invalid: number;
  blocked: JobspySite[];
  skipped: JobspySite[];
  errors: string[];
}

/** Collects from LinkedIn, Indeed, Glassdoor and Google Jobs through the sidecar, one search term at a time. */
export async function collectJobspy(db: Db, config: Config, opts: CollectOptions = {}): Promise<CollectSummary> {
  const cfg = config.sources.jobspy;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = (line: string) => logCollector(line, now(), opts.logDir);
  const summary: CollectSummary = { created: 0, linked: 0, flagged: 0, seenAgain: 0, invalid: 0, blocked: [], skipped: [], errors: [] };

  const wanted = cfg.sites.filter((s) => !opts.sites || opts.sites.includes(s));
  let active = wanted.filter((s) => {
    const off = !opts.force && isBlocked(db, s, now());
    if (off) summary.skipped.push(s);
    return !off;
  });
  if (summary.skipped.length) log(`jobspy skipped (blocked until midnight): ${summary.skipped.join(", ")}`);
  const failed = new Set<JobspySite>();
  const perSite = new Map<string, number>();

  for (const [i, search] of cfg.searches.entries()) {
    if (active.length === 0) break;
    if (i > 0) await sleep(config.limits.sidecar_delay_seconds * 1000);
    const hours = Math.max(...active.map((s) => windowHours(db, s, now(), cfg.window_margin_hours, cfg.max_hours_old)));
    const input: SidecarInput = {
      sites: active,
      search_term: search.term,
      google_search_term: `${search.term} jobs in ${search.location}`,
      location: search.location,
      country_indeed: search.country_indeed,
      is_remote: search.is_remote ?? false,
      hours_old: hours,
      results_wanted: cfg.results_wanted,
      fetch_description: cfg.fetch_description,
      description_format: "markdown",
    };
    const started = Date.now();
    const res = await runSidecar(input, opts.runner ?? defaultSidecar, config.limits.sidecar_timeout_seconds * 1000);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (res.error) {
      summary.errors.push(`"${search.term}": ${res.error}`);
      active.forEach((s) => failed.add(s));
      log(`jobspy term="${search.term}" sites=${active.join(",")} window=${hours}h ERROR ${res.error} ${seconds}s`);
      continue;
    }
    const postingsIn: PostingIn[] = [];
    let invalid = 0;
    for (const raw of res.records) {
      const parsed = jobspyRecordSchema.safeParse(raw);
      const posting = parsed.success ? toPosting(parsed.data) : null;
      if (posting) {
        postingsIn.push(posting);
        perSite.set(posting.source, (perSite.get(posting.source) ?? 0) + 1);
      }
      else invalid++;
    }
    const stored = ingest(db, postingsIn, config.dedupe, now());
    summary.created += stored.created;
    summary.seenAgain += stored.seenAgain;
    summary.linked += stored.linked;
    summary.flagged += stored.flagged;
    summary.invalid += invalid;
    res.failed.forEach((s) => failed.add(s));
    if (res.failed.length) summary.errors.push(`"${search.term}": failed on ${res.failed.join(", ")}`);
    for (const site of res.blocked) {
      markBlocked(db, site, now());
      summary.blocked.push(site);
    }
    log(
      `jobspy term="${search.term}" sites=${active.join(",")} window=${hours}h got=${res.records.length} ` +
        `new=${stored.created} linked=${stored.linked} flagged=${stored.flagged} seen=${stored.seenAgain} invalid=${invalid}` +
        `${res.blocked.length ? ` BLOCKED=${res.blocked.join(",")}` : ""}` +
        `${res.failed.length ? ` FAILED=${res.failed.join(",")}` : ""} ${seconds}s`,
    );
    active = active.filter((s) => !res.blocked.includes(s));
  }

  for (const site of active) if (!failed.has(site)) markSuccess(db, site, now(), perSite.get(site) ?? 0);
  return summary;
}
