import type { Config } from "./config.js";
import type { Language } from "./language.js";
import { isMyCity } from "./location.js";
import { hasPhrase, normalizeCompany, normalizeTitle } from "./normalize.js";
import type { Workplace } from "./status.js";

export interface PrefilterInput {
  company: string;
  title: string;
  workplace: Workplace;
  city: string | null;
  language: Language | null;
  postedAt: string | null;
}

/**
 * Cheap, deterministic cuts before (and right after) scoring. Returns the reason to filter the Job
 * out, or null if it passes. Remote Jobs pass from anywhere; hybrid/onsite Jobs outside my city are
 * cut (they would mean moving); unknown workplace or city passes.
 */
export function prefilter(job: PrefilterInput, config: Config, now = new Date()): string | null {
  const { filters, preferences: prefs } = config;

  const blocked = new Set(filters.blocked_companies.map(normalizeCompany));
  if (blocked.has(normalizeCompany(job.company))) return `blocked company: ${job.company}`;

  // Raw and normalized title: the normalized one expands "Jr."/"Sr." but drops text in parentheses.
  const inTitle = (w: string) => hasPhrase(job.title, w) || hasPhrase(normalizeTitle(job.title), w);
  const excluded = filters.exclude_title_words.find(inTitle);
  if (excluded) return `title has excluded word "${excluded}"`;
  if (filters.require_title_words.length > 0 && !filters.require_title_words.some(inTitle))
    return "title has none of the required words (not a developer role)";

  if (job.language && !prefs.languages.includes(job.language)) return `language ${job.language} not in preferences`;

  if (job.postedAt) {
    const days = Math.floor((now.getTime() - Date.parse(job.postedAt)) / 86_400_000);
    if (days > filters.max_age_days) return `posted ${days} days ago (max ${filters.max_age_days})`;
  }

  if (prefs.remote_only && (job.workplace === "hybrid" || job.workplace === "onsite")) return `${job.workplace} (remote_only is on)`;
  if ((job.workplace === "hybrid" || job.workplace === "onsite") && job.city && !isMyCity(job.city, prefs))
    return `${job.workplace} outside ${prefs.city} (${job.city})`;

  return null;
}
