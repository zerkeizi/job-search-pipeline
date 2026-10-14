import { eq, inArray } from "drizzle-orm";
import type { Config } from "./config.js";
import type { BaseCv } from "./cv/schema.js";
import type { Db } from "./db/index.js";
import { type Job, jobs, type Posting, postings } from "./db/schema.js";
import { detectLanguage } from "./language.js";
import { cityFromLocation, isMyCity, mentionsMyCity, officeDaysFromText, workplaceFromText } from "./location.js";
import { hasPhrase, normalizeTitle } from "./normalize.js";
import { prefilter } from "./prefilter.js";
import type { JobStatus, Workplace } from "./status.js";
import { matchTechnologies, type TechMatcher } from "./tech.js";

export interface ScoreDeps {
  db: Db;
  config: Config;
  cv: BaseCv;
  matcher: TechMatcher;
}

export interface Score {
  score: number;
  reason: string;
  matches: string[];
  gaps: string[];
}

// Weights of the score (0–100). Only fit to the Base CV counts; location never changes the score.
export const WEIGHTS = { tech: 0.6, title: 0.25, seniority: 0.15 };
/** Tech Lexicon categories that make up the core stack (languages and main frameworks). */
export const CORE_CATEGORIES = new Set(["languages", "frontend", "backend"]);
// Within the tech share: a core technology counts 1, any other (ORMs, cloud, tooling, practices) less,
// and one named in the title counts triple (the title states the main stack).
const SECONDARY_WEIGHT = 0.4;
const TITLE_FACTOR = 3;
const OTHER_LEVELS = ["junior", "estagio", "intern", "trainee", "especialista", "specialist", "staff", "principal", "lead"];

const titleHas = (title: string, word: string) =>
  hasPhrase(title, word) || hasPhrase(title.replaceAll("-", ""), word.replaceAll("-", ""));

/**
 * Deterministic score, no LLM: weighted share of the job's technologies that the Base CV has
 * (smoothed, so a description naming one or two technologies doesn't get full marks), title fit and
 * seniority.
 */
export function scoreJob(title: string, description: string, deps: Omit<ScoreDeps, "db">): Score {
  const { config, cv, matcher } = deps;
  const { matches, gaps } = matchTechnologies(matcher, cv, `${title}\n${description}`);
  const inTitle = new Set(matcher.find(title));
  const weight = (t: string) =>
    (CORE_CATEGORIES.has(matcher.category(t) ?? "") ? 1 : SECONDARY_WEIGHT) * (inTitle.has(t) ? TITLE_FACTOR : 1);
  const sum = (list: string[]) => list.reduce((acc, t) => acc + weight(t), 0);
  const tech = sum(matches) / (sum(matches) + sum(gaps) + 1);

  const target = config.preferences.target_titles.find((t) => titleHas(title, t));
  const devRole = config.filters.require_title_words.some((w) => titleHas(title, w));
  const titleFit = target ? 1 : devRole ? 0.5 : 0;

  const norm = normalizeTitle(title);
  const level = config.preferences.seniority.find((s) => hasPhrase(norm, s));
  const other = OTHER_LEVELS.find((s) => hasPhrase(norm, s));
  const seniority = level ? 1 : other ? 0.3 : 0.7;

  const score = Math.round(100 * (WEIGHTS.tech * tech + WEIGHTS.title * titleFit + WEIGHTS.seniority * seniority));
  const core = (list: string[]) => list.filter((t) => CORE_CATEGORIES.has(matcher.category(t) ?? "")).length;
  const reason = [
    `tech ${Math.round(tech * 100)}% (core ${core(matches)}/${core(matches) + core(gaps)}, all ${matches.length}/${matches.length + gaps.length})`,
    `title ${target ? `"${target}"` : devRole ? "generic dev role" : "off-target"}`,
    `seniority ${level ?? other ?? "not stated"}`,
  ].join(", ");
  return { score, reason, matches, gaps };
}

/** Workplace, city and office days of a Job, read by rules from its Postings and description. */
export function extractLocation(job: Job, all: Posting[], desc: Posting, prefs: Config["preferences"]) {
  let workplace: Workplace = job.workplace;
  for (const p of all) {
    if (workplace !== "unknown") break;
    workplace = workplaceFromText(`${p.title} ${p.location ?? ""}`, "field");
  }
  if (workplace === "unknown") workplace = workplaceFromText(desc.description, "description");

  const city =
    job.city ??
    [desc, ...all].map((p) => cityFromLocation(p.location)).find((c) => c !== null) ??
    (mentionsMyCity(desc.description, prefs) ? prefs.city : null);

  return { workplace, city, officeDays: job.officeDays ?? officeDaysFromText(desc.description) };
}

export interface ScoringSummary {
  scored: number;
  analysis: number;
  filteredOut: Record<string, number>;
  aboveThreshold: number;
}

/**
 * `jobpipe score`: pre-filter + score every `new` Job (with `all`, also re-evaluate `filtered_out`,
 * `scored` and `analysis` Jobs, e.g. after changing config; with `jobIds`, exactly those Jobs).
 * Manual Jobs are never filtered and never go to Analysis: they only get score, matches and Gaps.
 */
export function runScoring(
  deps: ScoreDeps,
  opts: { all?: boolean; jobIds?: string[] } = {},
  now = new Date(),
): ScoringSummary {
  const { db, config } = deps;
  const statuses: JobStatus[] = opts.all ? ["new", "filtered_out", "scored", "analysis"] : ["new"];
  const where = opts.jobIds ? inArray(jobs.id, opts.jobIds) : inArray(jobs.status, statuses);
  const summary: ScoringSummary = { scored: 0, analysis: 0, filteredOut: {}, aboveThreshold: 0 };

  for (const job of db.select().from(jobs).where(where).all()) {
    const all = db.select().from(postings).where(eq(postings.jobId, job.id)).all();
    const desc = all.find((p) => p.id === job.descriptionPostingId) ?? all[0];
    if (!desc) continue;
    const manual = all.some((p) => p.source === "manual");

    const loc = extractLocation(job, all, desc, config.preferences);
    const language = detectLanguage(desc.description);
    const s = scoreJob(job.title, desc.description, deps);
    const reason = manual
      ? null
      : prefilter({ company: job.company, title: job.title, ...loc, language, postedAt: desc.postedAt }, config, now);

    const high = s.score >= config.thresholds.generate;
    const status: JobStatus = reason
      ? "filtered_out"
      : job.analysisCandidateJobId && high && !manual
        ? "analysis"
        : "scored";

    db.update(jobs)
      .set({
        status,
        prefilterReason: reason,
        ...loc,
        language,
        score: s.score,
        scoreReason: s.reason,
        matches: s.matches,
        gaps: s.gaps,
      })
      .where(eq(jobs.id, job.id))
      .run();

    if (reason) {
      const kind = reason.replace(/[:(].*$/, "").replace(/"[^"]*"/, "").replace(/\d+/g, "N").trim();
      summary.filteredOut[kind] = (summary.filteredOut[kind] ?? 0) + 1;
    } else if (status === "analysis") summary.analysis++;
    else {
      summary.scored++;
      if (high) summary.aboveThreshold++;
    }
  }

  refreshLocalOffice(db, config.preferences);
  return summary;
}

/**
 * Recomputes Local Office for every Job: `posting` when its city is my city; `inherited` when another
 * Job of the same normalized company has a Local Office; `manual` (my correction) always prevails.
 */
export function refreshLocalOffice(db: Db, prefs: Config["preferences"]): void {
  const all = db.select().from(jobs).all();
  const own = (j: Job) => (j.localOfficeSource === "manual" ? j.localOffice : isMyCity(j.city, prefs));
  const companies = new Set(all.filter((j) => j.companyNorm && own(j)).map((j) => j.companyNorm));

  for (const j of all) {
    if (j.localOfficeSource === "manual") continue;
    const next = isMyCity(j.city, prefs)
      ? { localOffice: true, localOfficeSource: "posting" as const }
      : j.companyNorm && companies.has(j.companyNorm)
        ? { localOffice: true, localOfficeSource: "inherited" as const }
        : { localOffice: false, localOfficeSource: null };
    if (next.localOffice !== j.localOffice || next.localOfficeSource !== j.localOfficeSource)
      db.update(jobs).set(next).where(eq(jobs.id, j.id)).run();
  }
}
