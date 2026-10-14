const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
const squash = (s: string) => s.replace(/[^a-z0-9]+/g, " ").trim();

const COMPANY_SUFFIXES = /\b(ltda|s\.?\s?a|inc|llc|ltd|gmbh|corp|corporation|co|me|eireli|limited)\b\.?/g;

/** "Acme Tecnologia Ltda." → "acme tecnologia". */
export function normalizeCompany(name: string): string {
  return squash(stripAccents(name).toLowerCase().replace(COMPANY_SUFFIXES, " "));
}

/** "Sr. Node.js Developer (Remote) 🚀" → "senior node developer". */
export function normalizeTitle(title: string): string {
  const t = stripAccents(title)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bsr\.?(?=\s|$)/g, "senior")
    .replace(/\bjr\.?(?=\s|$)/g, "junior")
    .replace(/\b(node|react|vue|next|nest|nuxt)\.?js\b/g, "$1");
  return squash(t);
}

/** Lower case, no accents: for accent-insensitive matching ("Híbrido" → "hibrido"). */
export function fold(s: string): string {
  return stripAccents(s).toLowerCase();
}

/** True if `phrase` appears in `text` as whole words, ignoring case, accents and punctuation ("Full-Stack" ~ "full stack"). */
export function hasPhrase(text: string, phrase: string): boolean {
  const p = squash(fold(phrase));
  return p.length > 0 && ` ${squash(fold(text))} `.includes(` ${p} `);
}
