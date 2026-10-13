import { and, eq, gte } from "drizzle-orm";
import type { Config } from "./config.js";
import { canonicalUrl, descriptionSimilarity, ORIGIN_SOURCES, titlesSimilar } from "./dedupe.js";
import type { Db } from "./db/index.js";
import { jobs, postings } from "./db/schema.js";
import { stableId } from "./ids.js";
import { normalizeCompany, normalizeTitle } from "./normalize.js";
import type { Source, Workplace } from "./status.js";

/** What every collector returns (see CLAUDE.md, "Coletores"). */
export interface PostingIn {
  source: Source;
  externalId: string;
  url: string | null;
  applyUrl: string | null;
  company: string;
  title: string;
  location: string | null;
  workplace: Workplace;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryInterval: string | null;
  description: string;
  postedAt: string | null;
}

export interface IngestResult {
  /** New Jobs. */
  created: number;
  /** New Postings linked to an existing Job (same opening on another board, or a repost). */
  linked: number;
  /** Postings already stored. */
  seenAgain: number;
  /** New Jobs that may duplicate an existing one (go to Analysis if they score high). */
  flagged: number;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Finds the Job a new Posting belongs to, if any (rules 2 and 3 of the dedupe in CLAUDE.md). */
function findJob(tx: Tx, p: PostingIn, urlKey: string | null, since: string, dedupe: Config["dedupe"]) {
  if (urlKey) {
    const byUrl = tx.select({ jobId: postings.jobId }).from(postings).where(eq(postings.urlKey, urlKey)).get();
    if (byUrl) return { jobId: byUrl.jobId, similarTo: null };
  }
  const companyNorm = normalizeCompany(p.company);
  const titleNorm = normalizeTitle(p.title);
  const candidates = tx
    .select({ id: jobs.id, titleNorm: jobs.titleNorm, descriptionPostingId: jobs.descriptionPostingId })
    .from(jobs)
    .where(and(eq(jobs.companyNorm, companyNorm), gte(jobs.lastSeenAt, since)))
    .all()
    .filter((j) => companyNorm !== "" && titlesSimilar(titleNorm, j.titleNorm));
  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    const desc = c.descriptionPostingId
      ? tx.select({ d: postings.description }).from(postings).where(eq(postings.id, c.descriptionPostingId)).get()?.d
      : undefined;
    const score = desc ? descriptionSimilarity(desc, p.description) : 0;
    if (!best || score > best.score) best = { id: c.id, score };
  }
  if (best && best.score >= dedupe.same_threshold) return { jobId: best.id, similarTo: null };
  if (best && best.score >= dedupe.similar_threshold) return { jobId: null, similarTo: best.id };
  return { jobId: null, similarTo: null };
}

/**
 * Stores collected Postings, deduplicating across sources (CLAUDE.md, "Dedupe"):
 * 1. same source + external id → seen again; 2. same canonical apply URL → same Job;
 * 3. same company, similar title and similar description within the window → same Job, or a new Job
 *    flagged for Analysis when the description is only moderately similar; 4. otherwise a new Job.
 * Linking never re-scores or re-generates a Job nor changes its status.
 */
export function ingest(db: Db, items: PostingIn[], dedupe: Config["dedupe"], now = new Date()): IngestResult {
  const at = now.toISOString();
  const since = new Date(now.getTime() - dedupe.window_days * 86_400_000).toISOString();
  const result: IngestResult = { created: 0, linked: 0, seenAgain: 0, flagged: 0 };

  db.transaction((tx) => {
    for (const p of items) {
      const existing = tx
        .select({ jobId: postings.jobId })
        .from(postings)
        .where(and(eq(postings.source, p.source), eq(postings.externalId, p.externalId)))
        .get();
      if (existing) {
        tx.update(jobs).set({ lastSeenAt: at }).where(eq(jobs.id, existing.jobId)).run();
        result.seenAgain++;
        continue;
      }

      const id = stableId(p.source, p.externalId);
      const urlKey = canonicalUrl(p.applyUrl) ?? canonicalUrl(p.url);
      const { jobId, similarTo } = findJob(tx, p, urlKey, since, dedupe);

      if (jobId) {
        tx.insert(postings).values({ id, jobId, ...p, urlKey, collectedAt: at }).run();
        const job = tx.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
        const current = job.descriptionPostingId
          ? tx.select({ source: postings.source }).from(postings).where(eq(postings.id, job.descriptionPostingId)).get()
          : undefined;
        // Prefer the employer's own ATS for the description and the apply link.
        const preferNew = ORIGIN_SOURCES.has(p.source) && !(current && ORIGIN_SOURCES.has(current.source));
        tx.update(jobs)
          .set({
            lastSeenAt: at,
            ...(preferNew ? { descriptionPostingId: id, applyUrl: p.applyUrl ?? p.url } : {}),
            ...(job.workplace === "unknown" && p.workplace !== "unknown" ? { workplace: p.workplace } : {}),
          })
          .where(eq(jobs.id, jobId))
          .run();
        result.linked++;
        continue;
      }

      tx.insert(jobs)
        .values({
          id,
          status: "new",
          company: p.company,
          title: p.title,
          companyNorm: normalizeCompany(p.company),
          titleNorm: normalizeTitle(p.title),
          workplace: p.workplace,
          descriptionPostingId: id,
          applyUrl: p.applyUrl ?? p.url,
          analysisCandidateJobId: similarTo,
          firstSeenAt: at,
          lastSeenAt: at,
        })
        .run();
      tx.insert(postings).values({ id, jobId: id, ...p, urlKey, collectedAt: at }).run();
      result.created++;
      if (similarTo) result.flagged++;
    }
  });
  return result;
}
