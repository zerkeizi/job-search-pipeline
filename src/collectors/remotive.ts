import { z } from "zod";
import { htmlToText } from "../html.js";
import type { PostingIn } from "../ingest.js";
import { BlockedError } from "./http.js";
import { after, type ApiCollector, errorText } from "./types.js";

/**
 * Remotive public API (no auth). Their terms: at most ~4 requests a day (enforced by
 * sources.remotive.min_interval_hours), jobs delayed 24h, and always link back to the Remotive URL
 * (kept as the posting's url / apply url).
 */
const remotiveJob = z.looseObject({
  id: z.number(),
  url: z.string(),
  title: z.string(),
  company_name: z.string(),
  candidate_required_location: z.string().nullish(),
  publication_date: z.string().nullish(),
  description: z.string().nullish(),
  salary: z.string().nullish(),
});

export function toRemotivePosting(raw: unknown): PostingIn | null {
  const parsed = remotiveJob.safeParse(raw);
  if (!parsed.success || !parsed.data.description?.trim()) return null;
  const j = parsed.data;
  return {
    source: "remotive",
    externalId: String(j.id),
    url: j.url,
    applyUrl: j.url,
    company: j.company_name,
    title: j.title,
    location: j.candidate_required_location ?? null,
    workplace: "remote",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    description: htmlToText(j.description ?? ""),
    postedAt: j.publication_date ?? null,
  };
}

export const collectRemotive: ApiCollector = async function* ({ config, http, since }) {
  const { category, search } = config.sources.remotive;
  const params = new URLSearchParams({ category, ...(search ? { search } : {}) });
  try {
    const body = JSON.parse(await http.get(`https://remotive.com/api/remote-jobs?${params}`));
    const jobs = z.object({ jobs: z.array(z.unknown()) }).parse(body).jobs;
    yield { target: category, items: jobs.map(toRemotivePosting).filter((p): p is PostingIn => p !== null && after(p.postedAt, since)) };
  } catch (err) {
    if (err instanceof BlockedError) throw err;
    yield { target: category, items: [], error: errorText(err) };
  }
};
