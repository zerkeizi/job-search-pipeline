import { z } from "zod";
import type { PostingIn } from "../ingest.js";
import type { Workplace } from "../status.js";
import { BlockedError } from "./http.js";
import { after, type ApiCollector, errorText } from "./types.js";

/**
 * Gupy's public job portal (portal.gupy.io), logged out. The old JSON API is gone (404); the public
 * search page embeds the results — with full descriptions — in its __NEXT_DATA__ JSON (12 per page).
 */
const gupyJob = z.looseObject({
  id: z.number(),
  name: z.string(),
  description: z.string().nullish(),
  careerPageName: z.string().nullish(),
  publishedDate: z.string().nullish(),
  workplaceType: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  jobUrl: z.string(),
});

const pageData = z.object({
  props: z.object({ pageProps: z.object({ initialJobList: z.object({ data: z.array(z.unknown()) }) }) }),
});

const WORKPLACE: Record<string, Workplace> = { remote: "remote", hybrid: "hybrid", "on-site": "onsite", onsite: "onsite" };

export function parseGupyPage(html: string): unknown[] {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) throw new Error("gupy: __NEXT_DATA__ not found (page layout changed?)");
  return pageData.parse(JSON.parse(m[1])).props.pageProps.initialJobList.data;
}

export function toGupyPosting(raw: unknown): PostingIn | null {
  const parsed = gupyJob.safeParse(raw);
  if (!parsed.success || !parsed.data.description?.trim()) return null;
  const j = parsed.data;
  const url = j.jobUrl.split("?")[0]!;
  return {
    source: "gupy",
    externalId: String(j.id),
    url,
    applyUrl: url,
    company: j.careerPageName?.trim() || "Unknown company",
    title: j.name,
    location: [j.city, j.state].filter(Boolean).join(", ") || null,
    workplace: WORKPLACE[j.workplaceType ?? ""] ?? "unknown",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    description: j.description ?? "",
    postedAt: j.publishedDate ?? null,
  };
}

export const collectGupy: ApiCollector = async function* ({ config, http, since }) {
  for (const query of config.sources.gupy.queries) {
    try {
      const html = await http.get(`https://portal.gupy.io/job-search/term=${encodeURIComponent(query)}`);
      const items = parseGupyPage(html)
        .map(toGupyPosting)
        .filter((p): p is PostingIn => p !== null && after(p.postedAt, since));
      yield { target: query, items };
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      yield { target: query, items: [], error: errorText(err) };
    }
  }
};
