import type { Config } from "./config.js";
import { fold, hasPhrase } from "./normalize.js";
import type { Workplace } from "./status.js";

type Preferences = Config["preferences"];

const NOT_A_CITY =
  /^(remote|remoto|remota|trabalho remoto|home office|worldwide|anywhere|brazil|brasil|latam|latin america|americas|europe|usa|united states|hybrid|hibrido)$/;

/** First place name in a Posting location: "Porto Alegre, RS, Brazil" → "Porto Alegre"; "Remoto, Brazil" → null. */
export function cityFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const first = location
    .split(/\s*[,|/]\s*|\s+-\s+/)[0]
    ?.replace(/^greater\s+/i, "")
    .replace(/\s+(metropolitan area|area|region)$/i, "")
    .trim();
  if (!first || NOT_A_CITY.test(fold(first))) return null;
  return first;
}

/** Whether `city` is my city (`preferences.city` or one of its aliases). */
export function isMyCity(city: string | null | undefined, prefs: Preferences): boolean {
  if (!city) return false;
  const c = fold(cityFromLocation(city) ?? city);
  return [prefs.city, ...prefs.city_aliases].some((name) => fold(cityFromLocation(name) ?? name) === c);
}

/** Whether a text mentions my city (e.g. "Híbrido — Porto Alegre", "escritório em POA"). */
export function mentionsMyCity(text: string, prefs: Preferences): boolean {
  return [prefs.city, ...prefs.city_aliases].some((name) => hasPhrase(text, name));
}

const HYBRID = /\b(hybrid|hibrid[oa])\b/;
const ONSITE = /\b(presencial|on-?site|in[- ]office|in person)\b/;
const REMOTE = /\b(remote|remoto|remota|home office|trabalho remoto|anywhere)\b/;

/**
 * Workplace stated in a short field (title, location): the first clear signal wins.
 * In a description, only an unambiguous signal counts (hybrid; or remote without onsite, or vice versa),
 * because descriptions often mention both ("remote-first, with onsite events").
 */
export function workplaceFromText(text: string, kind: "field" | "description"): Workplace {
  const t = fold(text);
  const hybrid = HYBRID.test(t);
  const onsite = ONSITE.test(t);
  const remote = REMOTE.test(t);
  if (hybrid) return "hybrid";
  if (kind === "field") return remote ? "remote" : onsite ? "onsite" : "unknown";
  if (remote && !onsite) return "remote";
  if (onsite && !remote) return "onsite";
  return "unknown";
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
  uno: 1, dos: 2,
};
const N = "([1-5]|one|two|three|four|five|um|uma|dois|duas|tres|quatro|cinco|uno|dos)";
const OFFICE_DAYS = new RegExp(
  `\\b${N}(?:\\s*(?:-|a|to|ou|or|e|and)\\s*${N})?\\s*(?:x|vezes|times|days?|dias)` +
    `(?:\\s+(?:presenciais|presencial|in[- ]office|on[- ]?site|in the office|no escritorio|at the office))?` +
    `\\s*(?:por|a|per|na|each|every|of the)?\\s*(?:semana|week)`,
);

/** Office days per week stated in the text ("3x por semana", "2-3 days a week" → 3); null if not stated. */
export function officeDaysFromText(text: string): number | null {
  const m = OFFICE_DAYS.exec(fold(text));
  if (!m) return null;
  const toNumber = (s: string | undefined) => (s === undefined ? 0 : (NUMBER_WORDS[s] ?? Number(s)));
  return Math.max(toNumber(m[1]), toNumber(m[2])) || null;
}

/** Preferred Job: Local Office, not onsite, and office days unknown or within my limit. Computed, never stored. */
export function isPreferredJob(
  job: { localOffice: boolean; workplace: Workplace; officeDays: number | null },
  prefs: Preferences,
): boolean {
  return (
    job.localOffice &&
    job.workplace !== "onsite" &&
    (job.officeDays === null || job.officeDays <= prefs.max_office_days_per_week)
  );
}
