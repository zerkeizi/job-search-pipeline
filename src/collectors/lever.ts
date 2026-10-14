import { z } from "zod";
import { htmlToText } from "../html.js";
import type { PostingIn } from "../ingest.js";
import type { Workplace } from "../status.js";
import { BlockedError } from "./http.js";
import { after, type ApiCollector, displayName, errorText } from "./types.js";

/** Lever public Postings API: api.lever.co/v0/postings/<company>?mode=json (no auth). */
const leverJob = z.looseObject({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  applyUrl: z.string().nullish(),
  createdAt: z.number().nullish(),
  workplaceType: z.string().nullish(),
  categories: z.object({ location: z.string().nullish() }).nullish(),
  descriptionPlain: z.string().nullish(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
  additionalPlain: z.string().nullish(),
});

const WORKPLACE: Record<string, Workplace> = { remote: "remote", hybrid: "hybrid", onsite: "onsite" };

export function toLeverPosting(raw: unknown, company: string): PostingIn | null {
  const parsed = leverJob.safeParse(raw);
  if (!parsed.success) return null;
  const j = parsed.data;
  const description = [
    j.descriptionPlain ?? "",
    ...(j.lists ?? []).map((l) => `## ${l.text}\n${htmlToText(l.content)}`),
    j.additionalPlain ?? "",
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!description) return null;
  return {
    source: "lever",
    externalId: `${company}/${j.id}`,
    url: j.hostedUrl,
    applyUrl: j.applyUrl ?? j.hostedUrl,
    company: displayName(company),
    title: j.text,
    location: j.categories?.location ?? null,
    workplace: WORKPLACE[j.workplaceType ?? ""] ?? "unknown",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryInterval: null,
    description,
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  };
}

export const collectLever: ApiCollector = async function* ({ http, since, boards }) {
  for (const company of boards) {
    try {
      const body = z.array(z.unknown()).parse(JSON.parse(await http.get(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`)));
      const items = body.map((j) => toLeverPosting(j, company)).filter((p): p is PostingIn => p !== null && after(p.postedAt, since));
      yield { target: company, items };
    } catch (err) {
      if (err instanceof BlockedError) throw err;
      yield { target: company, items: [], error: errorText(err) };
    }
  }
};
