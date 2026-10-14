import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import type { Config } from "./config.js";
import type { BaseCv } from "./cv/schema.js";
import type { Db } from "./db/index.js";
import { jobs, postings } from "./db/schema.js";
import { guard, type TailoredContent } from "./guard.js";
import { type ClaudeRunner, QuotaExhaustedError } from "./llm.js";
import { normalizeCompany, normalizeTitle } from "./normalize.js";
import { fitCvToOnePage, type LineBudget, measureLineBudget } from "./render.js";
import { refreshLocalOffice, syncCompanies } from "./companies.js";
import { type GenerateMode, includesCoverLetter, includesCv, type PartialTailoring, tailor } from "./tailoring.js";
import { matchTechnologies, type TechMatcher } from "./tech.js";
import { UsageLog } from "./usage.js";

export interface GenerateDeps {
  db: Db;
  config: Config;
  cv: BaseCv;
  matcher: TechMatcher;
  runner?: ClaudeRunner;
  outputDir?: string;
  usage?: UsageLog;
}

export type GenerateOutcome =
  | {
      jobId: string;
      status: "generated";
      mode: GenerateMode;
      /** Null when only the cover letter was written. */
      pdfPath: string | null;
      scale: number | null;
      pageWarning: boolean;
      warnings: string[];
    }
  | { jobId: string; status: "blocked"; errors: string[] }
  | { jobId: string; status: "quota_exhausted" };

const fileSafe = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "Company";

const titleCase = (s: string) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** `Nicolas_Villanova_CV_<Company>.pdf` */
export function cvFileName(cv: BaseCv, company: string): string {
  return `${fileSafe(titleCase(cv.name))}_CV_${fileSafe(company)}.pdf`;
}

/** Base CV with the tailored summary and bullets; roles, dates and fixed sections stay from the Base CV. */
export function applyTailoring(cv: BaseCv, t: Pick<TailoredContent, "summary" | "experience">): BaseCv {
  return {
    ...cv,
    summary: t.summary,
    experience: cv.experience.map((e, i) => ({ ...e, bullets: t.experience[i]?.bullets ?? e.bullets })),
  };
}

/** What output/<job_id>/analysis.json holds: the tailoring output(s) plus what generate/edits added. */
export type StoredAnalysis = PartialTailoring & {
  deterministic?: { matches: string[]; gaps: string[] };
  guard?: { errors: string[]; warnings: string[] };
  render?: { scale: number; pages: number };
  edited_at?: string;
};

export function readAnalysis(outputDir: string, jobId: string): StoredAnalysis | null {
  const path = join(outputDir, jobId, "analysis.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StoredAnalysis) : null;
}

/** Which documents a Job has: a tailored CV, a cover letter, or both. */
export function partsOf(a: StoredAnalysis | null): { cv: boolean; coverLetter: boolean } {
  return { cv: Array.isArray(a?.experience), coverLetter: Boolean(a?.cover_letter) };
}

/** The guarded content: parts not generated fall back to the Base CV (or no cover letter), which always pass. */
export function contentOf(cv: BaseCv, a: Partial<TailoredContent>): TailoredContent {
  return {
    summary: a.summary ?? cv.summary,
    experience: a.experience ?? cv.experience.map((e) => ({ company: e.company, bullets: e.bullets })),
    cover_letter: a.cover_letter ?? "",
  };
}

/**
 * Jobs waiting for tailoring: `scored` and at/above the threshold (manual Jobs always qualify).
 * Order: manual Jobs, then Preferred Jobs, then by score.
 */
export function pendingJobIds(db: Db, config: Config, limit: number): string[] {
  const manual = sql`exists (select 1 from ${postings} where ${postings.jobId} = ${jobs.id} and ${postings.source} = 'manual')`;
  const preferred = sql`(${jobs.localOffice} = 1 and ${jobs.workplace} != 'onsite' and (${jobs.officeDays} is null or ${jobs.officeDays} <= ${config.preferences.max_office_days_per_week}))`;
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .where(sql`${jobs.status} = 'scored' and (${manual} or ${jobs.score} >= ${config.thresholds.generate})`)
    .orderBy(desc(manual), desc(preferred), desc(jobs.score))
    .limit(limit)
    .all()
    .map((r) => r.id);
}

/**
 * Tailors, guards and renders each Job. Stops at the first quota error (the remaining Jobs stay
 * `scored` for the next run) and never retries.
 */
export async function generate(jobIds: string[], deps: GenerateDeps, mode: GenerateMode = "both"): Promise<GenerateOutcome[]> {
  const { db, config, cv, matcher } = deps;
  const outputDir = deps.outputDir ?? "output";
  const usage = deps.usage ?? new UsageLog("generate");
  const outcomes: GenerateOutcome[] = [];
  let budget: LineBudget | undefined;

  for (const jobId of jobIds) {
    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const posting = job?.descriptionPostingId
      ? db.select().from(postings).where(eq(postings.id, job.descriptionPostingId)).get()
      : undefined;
    if (!job || !posting) throw new Error(`job ${jobId} or its description posting not found`);

    if (includesCv(mode)) budget ??= await measureLineBudget(cv, config.render);
    const { matches, gaps } = matchTechnologies(matcher, cv, posting.description);

    let result;
    try {
      result = await tailor(
        { cv, description: posting.description, matches, gaps, budget, mode },
        { model: config.models.tailoring, timeoutMs: config.limits.llm_timeout_seconds * 1000, runner: deps.runner },
      );
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        outcomes.push({ jobId, status: "quota_exhausted" });
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      db.update(jobs).set({ status: "blocked", guardErrors: [`tailoring failed: ${message}`] }).where(eq(jobs.id, jobId)).run();
      outcomes.push({ jobId, status: "blocked", errors: [message] });
      continue;
    }
    usage.record(result.usage, result.quota, jobId);
    const t = result.output;

    const facts = t.job;
    // A manual Job may come without company and/or title: the tailoring reads them from the text.
    const company = job.companyNorm !== "" ? job.company : facts.company;
    const title = job.titleNorm !== "" ? job.title : facts.title;
    db.update(jobs)
      .set({
        company,
        title,
        companyNorm: normalizeCompany(company),
        titleNorm: normalizeTitle(title),
        workplace: facts.workplace !== "unknown" ? facts.workplace : job.workplace,
        city: facts.office_city ?? job.city,
        officeDays: facts.office_days_per_week ?? job.officeDays,
        matches,
        gaps,
      })
      .where(eq(jobs.id, jobId))
      .run();

    // Generating one part keeps the other one from an earlier run (with my edits).
    const dir = join(outputDir, jobId);
    mkdirSync(dir, { recursive: true });
    const previous = readAnalysis(outputDir, jobId);
    const merged: StoredAnalysis = { ...previous, ...t };
    const content = contentOf(cv, merged);
    const checked = guard(cv, content, matcher);
    const analysis: StoredAnalysis = { ...merged, deterministic: { matches, gaps }, guard: checked };
    delete analysis.edited_at;
    const save = (a: StoredAnalysis) => writeFileSync(join(dir, "analysis.json"), JSON.stringify({ ...a, usage: result.usage }, null, 2));

    if (checked.errors.length > 0) {
      save(analysis);
      db.update(jobs).set({ status: "blocked", guardErrors: checked.errors }).where(eq(jobs.id, jobId)).run();
      outcomes.push({ jobId, status: "blocked", errors: checked.errors });
      continue;
    }

    let pdfPath: string | null = null;
    let fit: { scale: number; pages: number } | null = null;
    if (includesCv(mode)) {
      for (const f of existsSync(dir) ? readdirSync(dir) : []) if (f.endsWith(".pdf")) rmSync(join(dir, f));
      pdfPath = join(dir, cvFileName(cv, company));
      fit = await fitCvToOnePage(applyTailoring(cv, content), config.render, pdfPath);
      rmSync(pdfPath.replace(/\.pdf$/, ".html"), { force: true });
      analysis.render = fit;
    }
    if (includesCoverLetter(mode)) writeFileSync(join(dir, "cover_letter.md"), content.cover_letter.trim() + "\n");
    save(analysis);
    const pageWarning = fit ? fit.pages > 1 : job.pageWarning;
    db.update(jobs)
      .set({ status: "generated", guardErrors: null, pageWarning })
      .where(eq(jobs.id, jobId))
      .run();
    outcomes.push({ jobId, status: "generated", mode, pdfPath, scale: fit?.scale ?? null, pageWarning, warnings: checked.warnings });
  }
  // The tailoring may have named the company of a manual Job and corrected cities; Local Office follows.
  syncCompanies(db);
  refreshLocalOffice(db, config.preferences);
  return outcomes;
}
