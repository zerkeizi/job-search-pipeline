import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { jobs, postings } from "../db/schema.js";
import { canonicalUrl } from "../dedupe.js";
import { stableId } from "../ids.js";
import { normalizeCompany, normalizeTitle } from "../normalize.js";
import type { JobStatus, Workplace } from "../status.js";

export const UNKNOWN_COMPANY = "Unknown company";
export const UNKNOWN_TITLE = "Unknown title";

/** A job I picked myself: from `jobpipe add <file.txt>` or the panel's "Add job" form. */
export interface ManualJobInput {
  description: string;
  url?: string | null;
  /** When I leave company/title out, the tailoring call reads them from the text. */
  company?: string | null;
  title?: string | null;
  location?: string | null;
  workplace?: Workplace;
}

export interface ManualJobResult {
  jobId: string;
  /** A new Job was created. */
  created: boolean;
  /** Why no Job was created: the same text was added before, or the link is a Job already collected. */
  existing?: "same_text" | "same_link";
  status: JobStatus;
}

// A Job I add by hand goes back to the Queue unless it's already further along.
const REQUEUE: JobStatus[] = ["new", "filtered_out", "scored", "discarded"];

/**
 * Adds a manual Job. It skips the pre-filter and the score threshold (status `scored`, first in
 * the Queue); scoring still runs for matches and Gaps. The same text twice returns the existing
 * Job; a link that is already a collected Job attaches to it (and puts it back in the Queue if it
 * had been filtered out or discarded) instead of duplicating it.
 */
export function addManualJob(db: Db, input: ManualJobInput, now = new Date()): ManualJobResult {
  const description = input.description.trim();
  if (!description) throw new Error("the job description is empty");
  const url = input.url?.trim() || null;
  const externalId = stableId(description);
  const statusOf = (id: string) => db.select({ s: jobs.status }).from(jobs).where(eq(jobs.id, id)).get()!.s;

  const sameText = db
    .select({ jobId: postings.jobId })
    .from(postings)
    .where(and(eq(postings.source, "manual"), eq(postings.externalId, externalId)))
    .get();
  if (sameText) return { jobId: sameText.jobId, created: false, existing: "same_text", status: statusOf(sameText.jobId) };

  const at = now.toISOString();
  const company = input.company?.trim() || null;
  const title = input.title?.trim() || null;
  const urlKey = canonicalUrl(url);
  const posting = {
    source: "manual" as const,
    externalId,
    url,
    applyUrl: url,
    urlKey,
    company: company ?? UNKNOWN_COMPANY,
    title: title ?? UNKNOWN_TITLE,
    location: input.location?.trim() || null,
    workplace: input.workplace ?? "unknown",
    description,
    collectedAt: at,
  };

  const sameLink = urlKey ? db.select({ jobId: postings.jobId }).from(postings).where(eq(postings.urlKey, urlKey)).get() : undefined;
  if (sameLink) {
    const jobId = sameLink.jobId;
    db.transaction((tx) => {
      tx.insert(postings).values({ id: stableId("manual", externalId), jobId, ...posting }).run();
      const status = tx.select({ s: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get()!.s;
      if (REQUEUE.includes(status))
        tx.update(jobs).set({ status: "scored", prefilterReason: null, discardReason: null, lastSeenAt: at }).where(eq(jobs.id, jobId)).run();
    });
    return { jobId, created: false, existing: "same_link", status: statusOf(jobId) };
  }

  const jobId = stableId("manual", externalId);
  db.transaction((tx) => {
    tx.insert(jobs)
      .values({
        id: jobId,
        status: "scored",
        company: posting.company,
        title: posting.title,
        companyNorm: company ? normalizeCompany(company) : "",
        titleNorm: title ? normalizeTitle(title) : "",
        workplace: posting.workplace,
        descriptionPostingId: jobId,
        applyUrl: url,
        firstSeenAt: at,
        lastSeenAt: at,
      })
      .run();
    tx.insert(postings).values({ id: jobId, jobId, ...posting }).run();
  });
  return { jobId, created: true, status: "scored" };
}

/** `jobpipe add <file.txt> [--url]`. */
export function addManualJobFromFile(db: Db, file: string, url?: string, now = new Date()): ManualJobResult {
  const description = readFileSync(file, "utf8").trim();
  if (!description) throw new Error(`${file} is empty`);
  return addManualJob(db, { description, url }, now);
}
