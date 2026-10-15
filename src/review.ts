import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Config } from "./config.js";
import type { BaseCv } from "./cv/schema.js";
import type { Db } from "./db/index.js";
import { collectorState, companies, companyBoards, companyNames, type Job, jobs, postings } from "./db/schema.js";
import { descriptionSimilarity, ORIGIN_SOURCES } from "./dedupe.js";
import { applyTailoring, contentOf, cvFileName, partsOf, readAnalysis, type StoredAnalysis } from "./generate.js";
import { guard } from "./guard.js";
import { isPreferredJob } from "./location.js";
import { normalizeCompany } from "./normalize.js";
import { fitCvToOnePage } from "./render.js";
import { followedBoards, refreshLocalOffice, setCompanyLocalOffice } from "./companies.js";
import { SOURCES } from "./status.js";
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

/**
 * Where a Job's files are, to find them when uploading: the folder, the PDF name, and under WSL
 * the same folder as Windows sees it (paste it into Explorer or a browser's upload dialog).
 */
export function outputInfo(outputDir: string, jobId: string, distro: string | null | undefined = process.env.WSL_DISTRO_NAME) {
  const dir = resolve(outputDir, jobId);
  const pdf = pdfPathOf(outputDir, jobId);
  return {
    dir,
    windowsDir: distro ? `\\\\wsl.localhost\\${distro}${dir.replaceAll("/", "\\")}` : null,
    pdfName: pdf ? basename(pdf) : null,
  };
}

export function pdfPathOf(outputDir: string, jobId: string): string | null {
  const dir = join(outputDir, jobId);
  if (!existsSync(dir)) return null;
  const pdf = readdirSync(dir).find((f) => f.endsWith(".pdf"));
  return pdf ? join(dir, pdf) : null;
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
  appliedAt: job.appliedAt,
  companyId: job.companyId,
  /** How many other Jobs of this Company I already applied to. */
  appliedAtCompany: job.companyId
    ? (db
        .select({ n: sql<number>`count(*)` })
        .from(jobs)
        .where(and(eq(jobs.companyId, job.companyId), eq(jobs.status, "applied"), ne(jobs.id, job.id)))
        .get()?.n ?? 0)
    : 0,
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
    matches: job.matches ?? [],
    gaps: job.gaps ?? [],
    postings: deps.db
      .select({ source: postings.source, url: postings.url, location: postings.location, postedAt: postings.postedAt })
      .from(postings)
      .where(eq(postings.jobId, id))
      .all(),
    analysis,
    parts: partsOf(analysis),
    coverLetter: existsSync(coverPath) ? readFileSync(coverPath, "utf8") : (analysis?.cover_letter ?? ""),
    hasPdf: pdfPathOf(deps.outputDir, id) !== null,
    output: outputInfo(deps.outputDir, id),
    base: { summary: deps.cv.summary, experience: deps.cv.experience.map((e) => ({ company: e.company, role: e.role, bullets: e.bullets })) },
  };
}

/** Edited parts; only the parts the Job has can be edited. */
export interface Edits {
  summary?: string;
  bullets?: string[][];
  coverLetter?: string;
}

/**
 * My edits in the panel: they go through the guard before anything is saved. A rejected edit
 * changes nothing; if the text is true, the right place for it is cv/base.yaml. The PDF is
 * re-rendered only when the CV changed.
 */
export async function saveEdits(deps: ReviewDeps, id: string, edits: Edits) {
  const job = getJob(deps.db, id);
  const analysis = readAnalysis(deps.outputDir, id);
  const parts = partsOf(analysis);
  if (!analysis || (!parts.cv && !parts.coverLetter))
    throw new ReviewError("this job has nothing generated to edit; generate it first", 409);
  const cvEdited = edits.summary !== undefined || edits.bullets !== undefined;
  if (cvEdited && !parts.cv) throw new ReviewError("this job has no tailored CV; generate the CV first", 409);
  if (edits.coverLetter !== undefined && !parts.coverLetter)
    throw new ReviewError("this job has no cover letter; generate it first", 409);
  if (edits.bullets && edits.bullets.length !== deps.cv.experience.length)
    throw new ReviewError(`expected bullets for ${deps.cv.experience.length} companies`, 400);

  const next: StoredAnalysis = {
    ...analysis,
    ...(edits.summary !== undefined ? { summary: edits.summary.trim() } : {}),
    ...(edits.bullets
      ? {
          experience: deps.cv.experience.map((e, i) => ({
            company: e.company,
            bullets: edits.bullets![i]!.map((b) => b.trim()).filter(Boolean),
          })),
        }
      : {}),
    ...(edits.coverLetter !== undefined ? { cover_letter: edits.coverLetter.trim() } : {}),
  };
  const content = contentOf(deps.cv, next);
  const checked = guard(deps.cv, content, deps.matcher);
  if (checked.errors.length > 0)
    throw new ReviewError(
      "edit rejected by the guard — nothing was saved. If it's true, add it to cv/base.yaml first.",
      422,
      checked.errors,
    );

  let fit = analysis.render ?? null;
  if (cvEdited) {
    const old = pdfPathOf(deps.outputDir, id);
    if (old) rmSync(old);
    const pdfPath = join(deps.outputDir, id, cvFileName(deps.cv, job.company));
    fit = await fitCvToOnePage(applyTailoring(deps.cv, content), deps.config.render, pdfPath);
    rmSync(pdfPath.replace(/\.pdf$/, ".html"), { force: true });
  }

  const stored: StoredAnalysis = { ...next, guard: checked, ...(fit ? { render: fit } : {}), edited_at: new Date().toISOString() };
  writeFileSync(join(deps.outputDir, id, "analysis.json"), JSON.stringify(stored, null, 2));
  if (parts.coverLetter) writeFileSync(join(deps.outputDir, id, "cover_letter.md"), `${content.cover_letter}\n`);
  const pageWarning = cvEdited && fit ? fit.pages > 1 : job.pageWarning;
  deps.db.update(jobs).set({ status: "generated", guardErrors: null, pageWarning }).where(eq(jobs.id, id)).run();
  return { warnings: checked.warnings, scale: fit?.scale ?? null, pageWarning };
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

/**
 * The tailoring queue: `scored` Jobs in the order `generate` takes them (manual Jobs first, then
 * Preferred Jobs, then by score). Manual Jobs ignore the threshold; the others below it are only
 * generated if I ask.
 */
export function listQueue(deps: ReviewDeps) {
  const threshold = deps.config.thresholds.generate;
  const list = deps.db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "scored"))
    .all()
    .map((j) => {
      const s = summaryOf(deps.db, deps.config.preferences, j);
      const manual = s.sources.includes("manual");
      return { ...s, manual, aboveThreshold: manual || (j.score ?? 0) >= threshold };
    })
    .sort(
      (a, b) =>
        Number(b.aboveThreshold) - Number(a.aboveThreshold) ||
        Number(b.manual) - Number(a.manual) ||
        Number(b.preferred) - Number(a.preferred) ||
        (b.score ?? -1) - (a.score ?? -1),
    );
  return { threshold, jobs: list };
}

/** Applied Jobs, most recent first (read-only in the panel; tracking goes on in my spreadsheet). */
export function listApplied(deps: ReviewDeps): JobSummary[] {
  return deps.db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "applied"))
    .all()
    .map((j) => summaryOf(deps.db, deps.config.preferences, j))
    .sort((a, b) => (b.appliedAt ?? "").localeCompare(a.appliedAt ?? ""));
}

/** Undo a mistaken "Mark as applied": back to review. */
export function undoApplied(db: Db, id: string): void {
  const job = getJob(db, id);
  if (job.status !== "applied") throw new ReviewError(`job ${id} is not applied`, 409);
  db.update(jobs).set({ status: "generated", appliedAt: null }).where(eq(jobs.id, id)).run();
}

/**
 * My Local Office correction. It belongs to the Company (all its Jobs follow, `manual` prevails);
 * a Job without a Company keeps it on the Job. null clears it and lets the rules decide again.
 */
export function setLocalOffice(deps: ReviewDeps, id: string, value: boolean | null): void {
  const job = getJob(deps.db, id);
  if (job.companyId) return setCompanyLocalOffice(deps.db, job.companyId, value, deps.config.preferences);
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
    if (s === "greenhouse" || s === "lever" || s === "ashby") return sources[s].enabled && followedBoards(deps.db, s).length > 0;
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

/** The company catalog: followed first, then by how many fitting jobs their boards have, then by Jobs collected. */
export function listCompanies(deps: ReviewDeps) {
  const { db } = deps;
  const boards = db.select().from(companyBoards).all();
  const names = db.select().from(companyNames).all();
  const jobRows = db
    .select({ companyId: jobs.companyId, status: jobs.status, score: jobs.score, lastSeenAt: jobs.lastSeenAt })
    .from(jobs)
    .all();
  return db
    .select()
    .from(companies)
    .all()
    .map((c) => {
      const own = jobRows.filter((j) => j.companyId === c.id);
      const b = boards.filter((x) => x.companyId === c.id);
      return {
        id: c.id,
        name: c.name,
        aliases: names.filter((n) => n.companyId === c.id && n.nameNorm !== normalizeCompany(c.name)).map((n) => n.nameNorm),
        followed: c.followed,
        localOffice: c.localOffice,
        localOfficeSource: c.localOfficeSource,
        notes: c.notes,
        boards: b.map((x) => ({
          ats: x.ats,
          slug: x.slug,
          discoveredFrom: x.discoveredFrom,
          checkStatus: x.checkStatus,
          checkError: x.checkError,
          checkedAt: x.checkedAt,
          openJobs: x.openJobs,
          devJobs: x.devJobs,
          fitJobs: x.fitJobs,
        })),
        fitJobs: b.reduce((n, x) => n + (x.fitJobs ?? 0), 0),
        jobs: own.length,
        applied: own.filter((j) => j.status === "applied").length,
        bestScore: own.reduce<number | null>((m, j) => (j.score !== null && (m === null || j.score > m) ? j.score : m), null),
        lastSeenAt: own.reduce<string | null>((m, j) => (m === null || j.lastSeenAt > m ? j.lastSeenAt : m), null),
      };
    })
    .sort(
      (a, b) =>
        Number(b.followed) - Number(a.followed) ||
        b.fitJobs - a.fitJobs ||
        b.boards.length - a.boards.length ||
        b.jobs - a.jobs ||
        a.name.localeCompare(b.name),
    );
}
