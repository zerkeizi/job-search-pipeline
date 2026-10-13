import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { jobs, postings } from "../db/schema.js";
import { stableId } from "../ids.js";

export const UNKNOWN_COMPANY = "Unknown company";
export const UNKNOWN_TITLE = "Unknown title";

/**
 * `jobpipe add <file.txt> [--url]`: a Job I picked myself. It skips the pre-filter and the score
 * threshold (status goes straight to `scored`). Company and title are read from the text by the
 * tailoring call. Adding the same text twice returns the existing Job.
 */
export function addManualJob(db: Db, file: string, url?: string, now = new Date()): { jobId: string; created: boolean } {
  const description = readFileSync(file, "utf8").trim();
  if (!description) throw new Error(`${file} is empty`);
  const externalId = stableId(description);

  const existing = db
    .select({ jobId: postings.jobId })
    .from(postings)
    .where(and(eq(postings.source, "manual"), eq(postings.externalId, externalId)))
    .get();
  if (existing) return { jobId: existing.jobId, created: false };

  const jobId = stableId("manual", externalId);
  const at = now.toISOString();
  db.transaction((tx) => {
    tx.insert(jobs)
      .values({
        id: jobId,
        status: "scored",
        company: UNKNOWN_COMPANY,
        title: UNKNOWN_TITLE,
        companyNorm: "",
        titleNorm: "",
        descriptionPostingId: jobId,
        applyUrl: url ?? null,
        firstSeenAt: at,
        lastSeenAt: at,
      })
      .run();
    tx.insert(postings)
      .values({
        id: jobId,
        jobId,
        source: "manual",
        externalId,
        url: url ?? null,
        applyUrl: url ?? null,
        company: UNKNOWN_COMPANY,
        title: UNKNOWN_TITLE,
        description,
        collectedAt: at,
      })
      .run();
  });
  return { jobId, created: true };
}
