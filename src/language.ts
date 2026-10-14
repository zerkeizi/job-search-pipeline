import { fold } from "./normalize.js";

export type Language = "en" | "pt" | "es";

// Frequent words that tell the three languages apart (accents folded; words shared by pt and es left out).
const STOPWORDS: Record<Language, Set<string>> = {
  en: new Set("the and of to with you we our for is are will in experience team skills your have this".split(" ")),
  pt: new Set("com voce nao uma sao os das dos ao em nosso nossa vaga desenvolvimento conhecimento atuar".split(" ")),
  es: new Set("y con los las del el usted tu nuestro nuestra es en desarrollo conocimiento trabajar somos".split(" ")),
};

/**
 * Language of a job description, by counting distinctive frequent words. Deterministic and offline.
 * Returns null when the text is too short to tell.
 */
export function detectLanguage(text: string): Language | null {
  const counts: Record<Language, number> = { en: 0, pt: 0, es: 0 };
  for (const word of fold(text).split(/[^a-z]+/)) {
    for (const lang of ["en", "pt", "es"] as const) if (STOPWORDS[lang].has(word)) counts[lang]++;
  }
  const ranked = (Object.entries(counts) as [Language, number][]).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 5 || best[1] === second?.[1]) return null;
  return best[0];
}
