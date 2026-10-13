import type { BaseCv } from "./cv/schema.js";
import { baseCvText, type TechMatcher } from "./tech.js";

/** The part of a tailored CV that the LLM (or I, in the panel) may change. */
export interface TailoredContent {
  summary: string;
  experience: { company: string; bullets: string[] }[];
  cover_letter: string;
}

export interface GuardResult {
  /** Violations: any of these blocks the generation. */
  errors: string[];
  /** Things worth a look in the panel; never block. */
  warnings: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50, hundred: 100,
  hundreds: 100, thousand: 1000, thousands: 1000, million: 1_000_000, millions: 1_000_000,
};

/** Numbers mentioned in text: digits not glued to letters ("PM2", "HTML5" are names) plus number words. */
export function numbersIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9.])\d+(?:[.,]\d+)?(?![A-Za-z0-9])/g)) {
    found.add(Number(m[0].replace(",", ".")));
  }
  for (const m of text.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    const n = NUMBER_WORDS[m[0]];
    if (n !== undefined) found.add(n);
  }
  return found;
}

/** Tokens that look like product names (inner capitals, dotted names, letters+digits), e.g. "GraphQL", "Next.js", "S3". */
function nameLikeTokens(text: string): string[] {
  const tokens = text.match(/[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*/g) ?? [];
  return tokens.filter((t) => /[a-z][A-Z]/.test(t) || /\.[a-z]/i.test(t) || (/[A-Za-z]/.test(t) && /\d/.test(t)));
}

export function guard(base: BaseCv, tailored: TailoredContent, matcher: TechMatcher): GuardResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const evidence = baseCvText(base);
  const allowedTech = new Set(matcher.find(evidence));
  const allowedNumbers = numbersIn([evidence, ...base.experience.flatMap((e) => [e.start, e.end])].join("\n"));
  const evidenceLower = evidence.toLowerCase();

  const pieces: [string, string][] = [
    ["summary", tailored.summary],
    ...tailored.experience.flatMap((e) => e.bullets.map((b, i): [string, string] => [`${e.company} bullet ${i + 1}`, b])),
    ["cover letter", tailored.cover_letter],
  ];

  for (const [where, text] of pieces) {
    for (const tech of matcher.find(text)) {
      if (!allowedTech.has(tech)) errors.push(`${where}: "${tech}" is not in the Base CV — if it's true, add it to cv/base.yaml`);
    }
    for (const n of numbersIn(text)) {
      if (!allowedNumbers.has(n)) errors.push(`${where}: number ${n} does not appear in the Base CV`);
    }
    for (const token of nameLikeTokens(text)) {
      if (!evidenceLower.includes(token.toLowerCase()) && matcher.find(token).length === 0) {
        warnings.push(`${where}: "${token}" looks like a product name not found in the Base CV`);
      }
    }
  }

  const companies = tailored.experience.map((e) => e.company);
  const expected = base.experience.map((e) => e.company);
  if (companies.join("\u0000") !== expected.join("\u0000")) {
    errors.push(`experience must list the same companies in the same order: ${expected.join(", ")}`);
  } else {
    base.experience.forEach((job, i) => {
      const count = tailored.experience[i]!.bullets.length;
      const min = Math.min(3, job.bullets.length);
      if (count < min) errors.push(`${job.company}: needs at least ${min} bullets, got ${count}`);
    });
  }
  if (!tailored.summary.trim()) errors.push("summary is empty");

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
