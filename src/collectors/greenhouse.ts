import { z } from "zod";
import { decodeEntities, htmlToText } from "../html.js";
import type { PostingIn } from "../ingest.js";
import { BlockedError } from "./http.js";
import { after, type ApiCollector, displayName, errorText } from "./types.js";

/** Greenhouse public Job Board API: boards-api.greenhouse.io/v1/boards/<board>/jobs?content=true (no auth). */
const ghJob = z.looseObject({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  content: z.string().nullish(),
  company_name: z.string().nullish(),
  first_published: z.string().nullish(),
  updated_at: z.string().nullish(),
});

export function toGreenhousePosting(raw: unknown, board: string): PostingIn | null {
  const parsed = ghJob.safeParse(raw);
  if (!parsed.success || !parsed.data.content) return null;
  const j = parsed.data;
  const location = j.location?.name ?? null;
  return {
    source: "greenhouse",
    externalId: `${board}/${j.id}`,
    url: j.absolute_url,
    applyUrl: j.absolute_url,
    company: j.company_name?.trim() || displayName(board),
    title: j.title,
    location,
    workplace: /remote|remoto/i.test(location ?? "") ? "remote" : /hybrid|h[íi]brido/i.test(location ?? "") ? "hybrid" : "unknown",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    // `content` comes HTML-escaped.
    description: htmlToText(decodeEntities(j.content ?? "")),
    postedAt: j.first_published ?? j.updated_at ?? null,
  };
}

export const collectGreenhouse: ApiCollector = async function* ({ config, http, since }) {
  for (const board of config.sources.greenhouse.companies) {
    try {
      const body = JSON.parse(await http.get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`));
      const jobs = z.object({ jobs: z.array(z.unknown()) }).parse(body).jobs;
      const items = jobs.map((j) => toGreenhousePosting(j, board)).filter((p): p is PostingIn => p !== null && after(p.postedAt, since));
      yield { target: board, items };
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      yield { target: board, items: [], error: errorText(err) };
    }
  }
};
