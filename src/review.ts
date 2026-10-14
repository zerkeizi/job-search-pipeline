import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Config } from "./config.js";
import type { BaseCv } from "./cv/schema.js";
import type { Db } from "./db/index.js";
import { collectorState, type Job, jobs, postings } from "./db/schema.js";
import { descriptionSimilarity, ORIGIN_SOURCES } from "./dedupe.js";
import { applyTailoring, cvFileName } from "./generate.js";
import { guard } from "./guard.js";
import { isPreferredJob } from "./location.js";
import { fitCvToOnePage } from "./render.js";
import { refreshLocalOffice } from "./scoring.js";
import { SOURCES } from "./status.js";
import type { TailoringOutput } from "./tailoring.js";
import type { TechMatcher } from "./tech.js";

/** Operations behind the review panel (src/server.ts). The panel never applies anywhere: I do. */
export interface ReviewDeps {
  db: Db;
  config: Config;
  cv: BaseCv;
  matcher: TechMatcher;
  outputDir: string;
}

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 400,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/** What analysis.json holds: the tailoring output plus what generate/edits added. */
export type StoredAnalysis = TailoringOutput & {
  deterministic?: { matches: string[]; gaps: string[] };
  guard?: { errors: string[]; warnings: string[] };
  render?: { scale: number; pages: number };
  edited_at?: string;
};

function getJob(db: Db, id: string): Job {
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new ReviewError(`job ${id} not found`, 404);
  return job;
}

const sourcesOf = (db: Db, jobId: string) => [
  ...new Set(db.select({ s: postings.source }).from(postings).where(eq(postings.jobId, jobId)).all().map((r) => r.s)),
];

const descriptionOf = (db: Db, job: Job) =>
  (job.descriptionPostingId
    ? db.select({ d: postings.description }).from(postings).where(eq(postings.id, job.descriptionPostingId)).get()?.d
    : undefined) ?? "";

export function pdfPathOf(outputDir: string, jobId: string): string | null {
  const dir = join(outputDir, jobId);
  if (!existsSync(dir)) return null;
  const pdf = readdirSync(dir).find((f) => f.endsWith(".pdf"));
  return pdf ? join(dir, pdf) : null;
}

function readAnalysis(outputDir: string, jobId: string): StoredAnalysis | null {
  const path = join(outputDir, jobId, "analysis.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StoredAnalysis) : null;
}

const summaryOf = (db: Db, prefs: Config["preferences"], job: Job) => ({
  id: job.id,
  status: job.status,
  company: job.company,
  title: job.title,
  score: job.score,
  workplace: job.workplace,
  city: job.city,
  officeDays: job.officeDays,
  localOffice: job.localOffice,
  localOfficeSource: job.localOfficeSource,
  preferred: isPreferredJob(job, prefs),
  sources: sourcesOf(db, job.id),
  applyUrl: job.applyUrl,
  pageWarning: job.pageWarning,
  guardErrors: job.guardErrors ?? [],
  firstSeenAt: job.firstSeenAt,
});

export type JobSummary = ReturnType<typeof summaryOf>;

/** Generated and blocked Jobs: Preferred Jobs first, then by score. */
export function listGenerated(deps: ReviewDeps): JobSummary[] {
  const rows = deps.db.select().from(jobs).where(inArray(jobs.status, ["generated", "blocked"])).all();
  return rows
    .map((j) => summaryOf(deps.db, deps.config.preferences, j))
    .sort((a, b) => Number(b.preferred) - Number(a.preferred) || (b.score ?? -1) - (a.score ?? -1));
}

export function jobDetail(deps: ReviewDeps, id: string) {
  const job = getJob(deps.db, id);
  const analysis = readAnalysis(deps.outputDir, id);
  const coverPath = join(deps.outputDir, id, "cover_letter.md");
  return {
    ...summaryOf(deps.db, deps.config.preferences, job),
    description: descriptionOf(deps.db, job),
    scoreReason: job.scoreReason,
    postings: deps.db
      .select({ source: postings.source, url: postings.url, location: postings.location, postedAt: postings.postedAt })
      .from(postings)
      .where(eq(postings.jobId, id))
      .all(),
    analysis,
    coverLetter: existsSync(coverPath) ? readFileSync(coverPath, "utf8") : (analysis?.cover_letter ?? ""),
    hasPdf: pdfPathOf(deps.outputDir, id) !== null,
    base: { summary: deps.cv.summary, experience: deps.cv.experience.map((e) => ({ company: e.company, role: e.role, bullets: e.bullets })) },
  };
}

export interface Edits {
  summary: string;
  bullets: string[][];
  coverLetter: string;
}

/**
 * My edits in the panel: they go through the guard before anything is saved. A rejected edit
 * changes nothing; if the text is true, the right place for it is cv/base.yaml.
 */
export async function saveEdits(deps: ReviewDeps, id: string, edits: Edits) {
  const job = getJob(deps.db, id);
  const analysis = readAnalysis(deps.outputDir, id);
  if (!analysis) throw new ReviewError("this job has no generated CV to edit; regenerate it first", 409);
  if (edits.bullets.length !== deps.cv.experience.length)
    throw new ReviewError(`expected bullets for ${deps.cv.experience.length} companies`, 400);

  const tailored: TailoringOutput = {
    ...analysis,
    summary: edits.summary.trim(),
    experience: deps.cv.experience.map((e, i) => ({
      company: e.company,
      bullets: edits.bullets[i]!.map((b) => b.trim()).filter(Boolean),
    })),
    cover_letter: edits.coverLetter.trim(),
  };
  const checked = guard(deps.cv, tailored, deps.matcher);
  if (checked.errors.length > 0)
    throw new ReviewError(
      "edit rejected by the guard — nothing was saved. If it's true, add it to cv/base.yaml first.",
      422,
      checked.errors,
    );

  const old = pdfPathOf(deps.outputDir, id);
  if (old) rmSync(old);
  const pdfPath = join(deps.outputDir, id, cvFileName(deps.cv, job.company));
  const fit = await fitCvToOnePage(applyTailoring(deps.cv, tailored), deps.config.render, pdfPath);
  rmSync(pdfPath.replace(/\.pdf$/, ".html"), { force: true });

  const stored: StoredAnalysis = { ...analysis, ...tailored, guard: checked, render: fit, edited_at: new Date().toISOString() };
  writeFileSync(join(deps.outputDir, id, "analysis.json"), JSON.stringify(stored, null, 2));
  writeFileSync(join(deps.outputDir, id, "cover_letter.md"), `${tailored.cover_letter}\n`);
  const pageWarning = fit.pages > 1;
  deps.db.update(jobs).set({ status: "generated", guardErrors: null, pageWarning }).where(eq(jobs.id, id)).run();
  return { warnings: checked.warnings, scale: fit.scale, pageWarning };
}

export function discardJob(db: Db, id: string, reason: string | null): void {
  getJob(db, id);
  db.update(jobs).set({ status: "discarded", discardReason: reason?.trim() || null }).where(eq(jobs.id, id)).run();
}

/** I applied (myself, outside the system). The end of the pipeline for this Job. */
export function markApplied(db: Db, id: string, now = new Date()): void {
  getJob(db, id);
  db.update(jobs).set({ status: "applied", appliedAt: now.toISOString() }).where(eq(jobs.id, id)).run();
}

/** My Local Office correction (`manual` prevails); null clears it and lets the rules decide again. */
export function setLocalOffice(deps: ReviewDeps, id: string, value: boolean | null): void {
  getJob(deps.db, id);
  deps.db
    .update(jobs)
    .set(value === null ? { localOffice: false, localOfficeSource: null } : { localOffice: value, localOfficeSource: "manual" })
    .where(eq(jobs.id, id))
    .run();
  refreshLocalOffice(deps.db, deps.config.preferences);
}

/** Jobs in Analysis, each next to the Job it may duplicate. */
export function listAnalysis(deps: ReviewDeps) {
  const { db } = deps;
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "analysis"))
    .all()
    .map((job) => {
      const candidate = job.analysisCandidateJobId
        ? db.select().from(jobs).where(eq(jobs.id, job.analysisCandidateJobId)).get()
        : undefined;
      const side = (j: Job) => ({
        ...summaryOf(db, deps.config.preferences, j),
        lastSeenAt: j.lastSeenAt,
        description: descriptionOf(db, j),
      });
      return {
        job: side(job),
        candidate: candidate ? side(candidate) : null,
        similarity: candidate ? descriptionSimilarity(descriptionOf(db, job), descriptionOf(db, candidate)) : null,
      };
    });
}

function inAnalysis(db: Db, id: string): Job & { analysisCandidateJobId: string } {
  const job = getJob(db, id);
  if (job.status !== "analysis" || !job.analysisCandidateJobId) throw new ReviewError(`job ${id} is not in Analysis`, 409);
  return job as Job & { analysisCandidateJobId: string };
}

/**
 * Merge: the Job's Postings move to the existing Job, which keeps its status; this Job is removed.
 * The employer's own ATS still wins for the description and apply link.
 */
export function mergeJob(deps: ReviewDeps, id: string): string {
  const { db } = deps;
  const job = inAnalysis(db, id);
  const target = getJob(db, job.analysisCandidateJobId);
  db.transaction((tx) => {
    const moved = tx.select().from(postings).where(eq(postings.jobId, id)).all();
    tx.update(postings).set({ jobId: target.id }).where(eq(postings.jobId, id)).run();
    const current = target.descriptionPostingId
      ? tx.select({ source: postings.source }).from(postings).where(eq(postings.id, target.descriptionPostingId)).get()
      : undefined;
    const origin = moved.find((p) => ORIGIN_SOURCES.has(p.source));
    const preferNew = origin && !(current && ORIGIN_SOURCES.has(current.source));
    tx.update(jobs)
      .set({
        lastSeenAt: job.lastSeenAt > target.lastSeenAt ? job.lastSeenAt : target.lastSeenAt,
        firstSeenAt: job.firstSeenAt < target.firstSeenAt ? job.firstSeenAt : target.firstSeenAt,
        ...(preferNew ? { descriptionPostingId: origin.id, applyUrl: origin.applyUrl ?? origin.url } : {}),
      })
      .where(eq(jobs.id, target.id))
      .run();
    tx.update(jobs).set({ analysisCandidateJobId: target.id }).where(eq(jobs.analysisCandidateJobId, id)).run();
    tx.delete(jobs).where(eq(jobs.id, id)).run();
  });
  rmSync(join(deps.outputDir, id), { recursive: true, force: true });
  return target.id;
}

/** Keep separate: the Job continues the pipeline (it scored at/above the threshold, so it is next for tailoring). */
export function keepSeparate(db: Db, id: string): void {
  inAnalysis(db, id);
  db.update(jobs).set({ status: "scored", analysisCandidateJobId: null }).where(eq(jobs.id, id)).run();
}

/** Status of every collector source: last success, block, last volume. */
export function collectorStatus(deps: ReviewDeps, now = new Date()) {
  const rows = new Map(deps.db.select().from(collectorState).all().map((r) => [r.source, r]));
  const { sources } = deps.config;
  const enabled = (s: string): boolean => {
    if (["linkedin", "indeed", "glassdoor", "google"].includes(s))
      return sources.jobspy.enabled && (sources.jobspy.sites as string[]).includes(s);
    if (s === "greenhouse" || s === "lever" || s === "ashby") return sources[s].enabled && sources[s].companies.length > 0;
    if (s === "gupy" || s === "remotive") return sources[s].enabled;
    return false;
  };
  return SOURCES.filter((s) => s !== "manual").map((source) => {
    const r = rows.get(source);
    const blocked = Boolean(r?.blockedUntil && new Date(r.blockedUntil) > now);
    return {
      source,
      enabled: enabled(source),
      lastSuccessAt: r?.lastSuccessAt ?? null,
      lastCount: r?.lastCount ?? null,
      blockedUntil: blocked ? r!.blockedUntil : null,
    };
  });
}
