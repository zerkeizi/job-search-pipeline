import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { BaseCv } from "./cv/schema.js";

const lexiconSchema = z.object({
  terms: z.record(z.string(), z.array(z.string())),
  case_sensitive: z.array(z.string()),
});
const aliasesSchema = z.record(z.string(), z.array(z.string()));

interface Form {
  canonical: string;
  pattern: RegExp;
  length: number;
}

/** Recognizes Tech Lexicon technologies (and their aliases) in free text. */
export class TechMatcher {
  private readonly forms: Form[];

  constructor(lexicon: z.infer<typeof lexiconSchema>, aliases: z.infer<typeof aliasesSchema>) {
    const caseSensitive = new Set(lexicon.case_sensitive);
    const canonicalOf = new Map<string, string>();
    for (const term of [...Object.values(lexicon.terms).flat(), ...lexicon.case_sensitive]) canonicalOf.set(term, term);
    for (const [canonical, list] of Object.entries(aliases)) {
      canonicalOf.set(canonical, canonical);
      for (const alias of list) canonicalOf.set(alias, canonical);
    }
    this.forms = [...canonicalOf].map(([form, canonical]) => ({
      canonical,
      length: form.length,
      // Alphanumeric boundaries only: "Node" must not match inside "NodeJS", but may sit next to "/" or ",".
      pattern: new RegExp(
        `(?<![A-Za-z0-9])${form.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![A-Za-z0-9])`,
        caseSensitive.has(form) ? "g" : "gi",
      ),
    }));
    // Longest forms first, so "Node.js" wins over "Node" and "PL/SQL" over "SQL".
    this.forms.sort((a, b) => b.length - a.length);
  }

  static load(lexiconPath = "cv/tech-lexicon.yaml", aliasesPath = "cv/aliases.yaml"): TechMatcher {
    return new TechMatcher(
      lexiconSchema.parse(parse(readFileSync(lexiconPath, "utf8"))),
      aliasesSchema.parse(parse(readFileSync(aliasesPath, "utf8"))),
    );
  }

  /** Canonical names of the technologies mentioned in `text`, in order of first appearance. */
  find(text: string): string[] {
    const taken: [number, number][] = [];
    const hits: { at: number; canonical: string }[] = [];
    for (const form of this.forms) {
      for (const m of text.matchAll(form.pattern)) {
        const start = m.index;
        const end = start + m[0].length;
        if (taken.some(([s, e]) => start < e && end > s)) continue;
        taken.push([start, end]);
        hits.push({ at: start, canonical: form.canonical });
      }
    }
    hits.sort((a, b) => a.at - b.at);
    return [...new Set(hits.map((h) => h.canonical))];
  }
}

/** The professional text of the Base CV: what counts as evidence of experience (contacts excluded). */
export function baseCvText(cv: BaseCv): string {
  return [
    cv.headline,
    cv.summary,
    ...cv.experience.flatMap((e) => [e.role, ...e.bullets]),
    ...cv.tech_skills.map((t) => t.items),
  ].join("\n");
}

/** Matches (in the Base CV) and Gaps (not in it) among the technologies a Job description mentions. */
export function matchTechnologies(matcher: TechMatcher, cv: BaseCv, description: string) {
  const mine = new Set(matcher.find(baseCvText(cv)));
  const wanted = matcher.find(description);
  return { matches: wanted.filter((t) => mine.has(t)), gaps: wanted.filter((t) => !mine.has(t)) };
}
