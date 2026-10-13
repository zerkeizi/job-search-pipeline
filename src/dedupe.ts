/**
 * Deterministic dedupe helpers (ADR 0001, ADR 0003). No LLM: URL canonicalization, title similarity
 * and description similarity (Jaccard over 3-word shingles).
 */

/** Sources that are the employer's own ATS: preferred for the Job's description and apply URL. */
export const ORIGIN_SOURCES = new Set(["gupy", "greenhouse", "lever", "ashby"]);

function gupyJobId(token: string): string | null {
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as { jobId?: number };
    return decoded.jobId ? String(decoded.jobId) : null;
  } catch {
    return null;
  }
}

/**
 * Canonical key of a job URL: same opening ⇒ same key, whichever board linked to it.
 * Drops scheme, "www.", query, fragment and trailing "/apply"-like suffixes, and unifies the
 * Greenhouse/Lever/Ashby/Gupy URL variants.
 */
export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const ghJobId = url.searchParams.get("gh_jid");

  if (host.endsWith("greenhouse.io")) {
    const i = parts.indexOf("jobs");
    if (i > 0 && parts[i + 1]) return `greenhouse/${parts[i - 1]!.toLowerCase()}/${parts[i + 1]}`;
  }
  if (ghJobId) return `greenhouse/*/${ghJobId}`;
  if (host === "jobs.lever.co" && parts.length >= 2) return `lever/${parts[0]!.toLowerCase()}/${parts[1]}`;
  if (host === "jobs.ashbyhq.com" && parts.length >= 2) return `ashby/${parts[0]!.toLowerCase()}/${parts[1]}`;
  if (host.endsWith(".gupy.io") && parts[0] === "job" && parts[1]) {
    const id = gupyJobId(decodeURIComponent(parts[1]));
    if (id) return `gupy/${id}`;
  }
  const path = parts.filter((p, i) => !(i === parts.length - 1 && /^(apply|application)$/i.test(p))).join("/");
  return `${host}/${path}`;
}

const words = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").match(/[a-z0-9]+/g) ?? [];

/** Normalized titles are equal, one contains the other's words (e.g. adds "senior"), or they share ≥ 75% of words. */
export function titlesSimilar(a: string, b: string): boolean {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return false;
  const shared = [...A].filter((w) => B.has(w)).length;
  if (shared === Math.min(A.size, B.size)) return true;
  return shared / new Set([...A, ...B]).size >= 0.75;
}

function shingles(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/** Jaccard similarity of 3-word shingles, 0..1. */
export function descriptionSimilarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const s of A) if (B.has(s)) shared++;
  return shared / (A.size + B.size - shared);
}
