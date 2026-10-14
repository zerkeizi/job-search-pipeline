import { z } from "zod";
import type { PostingIn } from "../ingest.js";
import type { Workplace } from "../status.js";
import { BlockedError } from "./http.js";
import { after, type ApiCollector, displayName, errorText } from "./types.js";

/** Ashby public Job Posting API: api.ashbyhq.com/posting-api/job-board/<board> (no auth). */
const ashbyJob = z.looseObject({
  id: z.string(),
  title: z.string(),
  jobUrl: z.string(),
  applyUrl: z.string().nullish(),
  location: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  publishedAt: z.string().nullish(),
});

const WORKPLACE: Record<string, Workplace> = { remote: "remote", hybrid: "hybrid", onsite: "onsite" };

export function toAshbyPosting(raw: unknown, board: string): PostingIn | null {
  const parsed = ashbyJob.safeParse(raw);
  if (!parsed.success || parsed.data.isListed === false || !parsed.data.descriptionPlain?.trim()) return null;
  const j = parsed.data;
  return {
    source: "ashby",
    externalId: `${board}/${j.id}`,
    url: j.jobUrl,
    applyUrl: j.applyUrl ?? j.jobUrl,
    company: displayName(board),
    title: j.title,
    location: j.location ?? null,
    workplace: WORKPLACE[(j.workplaceType ?? "").toLowerCase()] ?? (j.isRemote ? "remote" : "unknown"),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    description: j.descriptionPlain ?? "",
    postedAt: j.publishedAt ?? null,
  };
}

export const collectAshby: ApiCollector = async function* ({ http, since, boards }) {
  for (const board of boards) {
    try {
      const body = JSON.parse(await http.get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`));
      const jobs = z.object({ jobs: z.array(z.unknown()) }).parse(body).jobs;
      const items = jobs.map((j) => toAshbyPosting(j, board)).filter((p): p is PostingIn => p !== null && after(p.postedAt, since));
      yield { target: board, items };
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      yield { target: board, items: [], error: errorText(err) };
    }
  }
};
