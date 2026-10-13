import { and, eq } from "drizzle-orm";
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
  created: number;
  seenAgain: number;
}

/**
 * Stores collected Postings. A Posting already stored (same source + external id) only refreshes
 * its Job's last_seen_at. Everything else becomes a new Job in status `new`.
 * (Cross-source dedupe — linking a Posting to an existing Job — comes in phase 4.)
 */
export function ingest(db: Db, items: PostingIn[], now = new Date()): IngestResult {
  const at = now.toISOString();
  const result: IngestResult = { created: 0, seenAgain: 0 };
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
          firstSeenAt: at,
          lastSeenAt: at,
        })
        .run();
      tx.insert(postings).values({ id, jobId: id, ...p, collectedAt: at }).run();
      result.created++;
    }
  });
  return result;
}
