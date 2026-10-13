import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import type { Config } from "./config.js";
import type { BaseCv } from "./cv/schema.js";
import type { Db } from "./db/index.js";
import { jobs, postings } from "./db/schema.js";
import { guard } from "./guard.js";
import { type ClaudeRunner, QuotaExhaustedError } from "./llm.js";
import { normalizeCompany, normalizeTitle } from "./normalize.js";
import { fitCvToOnePage, type LineBudget, measureLineBudget } from "./render.js";
import { tailor, type TailoringOutput } from "./tailoring.js";
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
  | { jobId: string; status: "generated"; pdfPath: string; scale: number; pageWarning: boolean; warnings: string[] }
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
export function applyTailoring(cv: BaseCv, t: TailoringOutput): BaseCv {
  return {
    ...cv,
    summary: t.summary,
    experience: cv.experience.map((e, i) => ({ ...e, bullets: t.experience[i]?.bullets ?? e.bullets })),
  };
}

/** Jobs waiting for tailoring: `scored` and at/above the threshold (manual Jobs have no score and always qualify). */
export function pendingJobIds(db: Db, config: Config, limit: number): string[] {
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      sql`${jobs.status} = 'scored' and (${jobs.score} is null or ${jobs.score} >= ${config.thresholds.generate})`,
    )
    .orderBy(sql`${jobs.score} is not null`, desc(jobs.score))
    .limit(limit)
    .all()
    .map((r) => r.id);
}

/**
 * Tailors, guards and renders each Job. Stops at the first quota error (the remaining Jobs stay
 * `scored` for the next run) and never retries.
 */
export async function generate(jobIds: string[], deps: GenerateDeps): Promise<GenerateOutcome[]> {
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

    budget ??= await measureLineBudget(cv, config.render);
    const { matches, gaps } = matchTechnologies(matcher, cv, posting.description);

    let result;
    try {
      result = await tailor(
        { cv, description: posting.description, matches, gaps, budget },
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
    const known = job.companyNorm !== "";
    const company = known ? job.company : facts.company;
    const title = known ? job.title : facts.title;
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

    const dir = join(outputDir, jobId);
    mkdirSync(dir, { recursive: true });
    const checked = guard(cv, t, matcher);
    const analysis = { ...t, deterministic: { matches, gaps }, guard: checked, usage: result.usage };

    if (checked.errors.length > 0) {
      writeFileSync(join(dir, "analysis.json"), JSON.stringify(analysis, null, 2));
      db.update(jobs).set({ status: "blocked", guardErrors: checked.errors }).where(eq(jobs.id, jobId)).run();
      outcomes.push({ jobId, status: "blocked", errors: checked.errors });
      continue;
    }

    const pdfPath = join(dir, cvFileName(cv, company));
    const fit = await fitCvToOnePage(applyTailoring(cv, t), config.render, pdfPath);
    rmSync(pdfPath.replace(/\.pdf$/, ".html"), { force: true });
    writeFileSync(join(dir, "cover_letter.md"), t.cover_letter.trim() + "\n");
    writeFileSync(join(dir, "analysis.json"), JSON.stringify({ ...analysis, render: fit }, null, 2));
    const pageWarning = fit.pages > 1;
    db.update(jobs)
      .set({ status: "generated", guardErrors: null, pageWarning })
      .where(eq(jobs.id, jobId))
      .run();
    outcomes.push({ jobId, status: "generated", pdfPath, scale: fit.scale, pageWarning, warnings: checked.warnings });
  }
  return outcomes;
}
