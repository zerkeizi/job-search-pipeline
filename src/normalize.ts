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
