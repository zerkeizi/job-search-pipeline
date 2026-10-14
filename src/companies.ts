import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { logCollector, markBlocked } from "./collector-state.js";
import { BlockedError, type Http } from "./collectors/http.js";
import { displayName, errorText } from "./collectors/types.js";
import type { Config } from "./config.js";

type Preferences = Config["preferences"];
import type { Db } from "./db/index.js";
import { BOARD_ATS, type BoardAts, type Company, companies, companyBoards, companyNames, type Job, jobs, postings } from "./db/schema.js";
import { stableId } from "./ids.js";
import { isMyCity } from "./location.js";
import { normalizeCompany } from "./normalize.js";
import { titleCut } from "./prefilter.js";

/**
 * Companies (ADR 0006): every Job belongs to the Company whose name (or alias) matches its
 * normalized company name. Boards on Greenhouse/Lever/Ashby are discovered from the links of
 * collected Postings or imported; following a Company collects its boards.
 */

export class CompanyError extends Error {}

/** The Company for a display name, created if new. Null when the name normalizes to nothing. */
export function companyFor(db: Db, name: string, now = new Date()): string | null {
  const norm = normalizeCompany(name);
  if (!norm) return null;
  const known = db.select().from(companyNames).where(eq(companyNames.nameNorm, norm)).get();
  if (known) return known.companyId;
  const id = stableId("company", norm);
  db.insert(companies).values({ id, name: name.trim(), createdAt: now.toISOString() }).onConflictDoNothing().run();
  db.insert(companyNames).values({ nameNorm: norm, companyId: id }).run();
  return id;
}

/** "greenhouse/acme/123" (a Posting's url_key) → the board it came from. */
export function boardFromUrlKey(urlKey: string | null): { ats: BoardAts; slug: string } | null {
  const m = /^(greenhouse|lever|ashby)\/([^/*]+)\//.exec(urlKey ?? "");
  return m ? { ats: m[1] as BoardAts, slug: m[2]!.toLowerCase() } : null;
}

/** A board link or reference: boards.greenhouse.io/acme, jobs.lever.co/acme, jobs.ashbyhq.com/acme, "lever:acme". */
export function parseBoardRef(line: string): { ats: BoardAts; slug: string } | { slug: string } | null {
  const text = line.trim();
  if (!text || text.startsWith("#")) return null;
  const prefixed = /^(greenhouse|lever|ashby)\s*:\s*([A-Za-z0-9._-]+)$/i.exec(text);
  if (prefixed) return { ats: prefixed[1]!.toLowerCase() as BoardAts, slug: prefixed[2]!.toLowerCase() };
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    if (host.endsWith("greenhouse.io")) {
      const slug = host.startsWith("boards-api.") ? parts[2] : (url.searchParams.get("for") ?? parts[0]);
      if (slug) return { ats: "greenhouse", slug: slug.toLowerCase() };
    }
    if ((host === "jobs.lever.co" || host === "api.lever.co") && parts.length > 0)
      return { ats: "lever", slug: (host === "api.lever.co" ? parts[2] : parts[0])!.toLowerCase() };
    if (host === "jobs.ashbyhq.com" && parts[0]) return { ats: "ashby", slug: parts[0].toLowerCase() };
  } catch {
    // not a URL: maybe a bare slug
  }
  if (/^[A-Za-z0-9._-]+$/.test(text)) return { slug: text.toLowerCase() };
  return null;
}

export function addBoard(
  db: Db,
  companyId: string,
  ats: BoardAts,
  slug: string,
  from: "posting" | "import",
  now: Date,
  guessed = false,
): boolean {
  const res = db
    .insert(companyBoards)
    .values({ id: stableId("board", ats, slug), companyId, ats, slug, discoveredFrom: from, guessed, discoveredAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  return res.changes > 0;
}

/**
 * Links Jobs to Companies and discovers boards from Posting links. Idempotent and cheap: it only
 * touches Jobs without a Company and Postings whose board isn't known yet. Runs after every ingest.
 */
export function syncCompanies(db: Db, now = new Date()): { linked: number; boards: number } {
  let linked = 0;
  let boards = 0;
  for (const job of db
    .select({ id: jobs.id, company: jobs.company })
    .from(jobs)
    .where(and(isNull(jobs.companyId), ne(jobs.companyNorm, "")))
    .all()) {
    const companyId = companyFor(db, job.company, now);
    if (!companyId) continue;
    db.update(jobs).set({ companyId }).where(eq(jobs.id, job.id)).run();
    linked++;
  }

  const rows = db
    .select({ source: postings.source, externalId: postings.externalId, urlKey: postings.urlKey, companyId: jobs.companyId })
    .from(postings)
    .innerJoin(jobs, eq(jobs.id, postings.jobId))
    .where(sql`${jobs.companyId} is not null and (${postings.urlKey} like 'greenhouse/%' or ${postings.urlKey} like 'lever/%' or ${postings.urlKey} like 'ashby/%' or ${postings.source} in ('greenhouse', 'lever', 'ashby'))`)
    .all();
  for (const r of rows) {
    const fromSource =
      (BOARD_ATS as readonly string[]).includes(r.source) && r.externalId?.includes("/")
        ? { ats: r.source as BoardAts, slug: r.externalId.split("/")[0]!.toLowerCase() }
        : null;
    const board = fromSource ?? boardFromUrlKey(r.urlKey);
    if (board && addBoard(db, r.companyId!, board.ats, board.slug, "posting", now)) boards++;
  }
  return { linked, boards };
}

/**
 * `jobpipe companies import <file>`: one board per line — a board URL, "ats:slug", or a bare slug
 * (then all three ATSs are tried; the check drops the ones that don't exist). New boards get a
 * Company named after the slug until the check (or I) finds the real name.
 */
export function importBoards(db: Db, file: string, now = new Date()) {
  const result = { added: 0, known: 0, invalid: [] as string[] };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const ref = parseBoardRef(line);
    if (ref === null) {
      if (line.trim() && !line.trim().startsWith("#")) result.invalid.push(line.trim());
      continue;
    }
    const targets = "ats" in ref ? [ref.ats] : [...BOARD_ATS];
    const known = db
      .select({ companyId: companyBoards.companyId })
      .from(companyBoards)
      .where(and(eq(companyBoards.slug, ref.slug), inArray(companyBoards.ats, targets)))
      .get();
    const companyId = known?.companyId ?? companyFor(db, displayName(ref.slug), now)!;
    let added = false;
    for (const ats of targets) added = addBoard(db, companyId, ats, ref.slug, "import", now, !("ats" in ref)) || added;
    if (added) result.added++;
    else result.known++;
  }
  return result;
}

// ---- check: one request per board, same etiquette as the collectors ----

interface BoardJob {
  title: string;
  location: string;
  remote: boolean;
}

const BOARD_URL: Record<BoardAts, (slug: string) => string> = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`,
};

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Parses a board's job list: title, location, remote, and the company name when the ATS gives it. */
export function parseBoard(ats: BoardAts, body: string): { name: string | null; jobs: BoardJob[] } {
  const data = JSON.parse(body) as unknown;
  if (ats === "lever") {
    if (!Array.isArray(data)) throw new Error("unexpected Lever response");
    return {
      name: null,
      jobs: (data as Obj[]).map((j) => {
        const location = str((j.categories as Obj | undefined)?.location);
        return { title: str(j.text), location, remote: str(j.workplaceType) === "remote" || /remote/i.test(location) };
      }),
    };
  }
  const list = (data as Obj).jobs;
  if (!Array.isArray(list)) throw new Error(`unexpected ${ats} response`);
  if (ats === "greenhouse") {
    const jobsList = list as Obj[];
    return {
      name: jobsList.map((j) => str(j.company_name).trim()).find(Boolean) ?? null,
      jobs: jobsList.map((j) => {
        const location = str((j.location as Obj | undefined)?.name);
        return { title: str(j.title), location, remote: /remote|remoto/i.test(location) };
      }),
    };
  }
  return {
    name: null,
    jobs: (list as Obj[])
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        title: str(j.title),
        location: str(j.location),
        remote: j.isRemote === true || str(j.workplaceType).toLowerCase() === "remote",
      })),
  };
}

const FIT_LOCATION =
  /\b(brazil|brasil|latam|latin america|south america|americas|anywhere|worldwide|sao paulo|rio de janeiro|belo horizonte|curitiba|florianopolis|recife|porto alegre|campinas)\b/;

/** Counts for a board: open jobs, those passing my title filters, and of those the ones remote or in Brazil/LatAm. */
export function boardCounts(list: BoardJob[], config: Config) {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const dev = list.filter((j) => titleCut(j.title, config) === null);
  const fit = dev.filter((j) => j.remote || FIT_LOCATION.test(fold(j.location)) || isMyCity(j.location, config.preferences));
  return { openJobs: list.length, devJobs: dev.length, fitJobs: fit.length };
}

export interface CheckSummary {
  checked: number;
  ok: number;
  notFound: number;
  removedGuesses: number;
  errors: string[];
  blocked: BoardAts[];
}

/**
 * `jobpipe companies check`: fetches each unchecked board (or all, or those older than `staleDays`)
 * and records its counts. Polite: one request per board through the shared delayed client; a block
 * (429/403/captcha) stops that ATS until midnight, like the collectors. Never sends credentials.
 */
export async function checkBoards(
  db: Db,
  config: Config,
  http: Http,
  opts: { all?: boolean; staleDays?: number; now?: () => Date; logDir?: string } = {},
): Promise<CheckSummary> {
  const now = opts.now ?? (() => new Date());
  const staleBefore = new Date(now().getTime() - (opts.staleDays ?? 7) * 86_400_000).toISOString();
  const summary: CheckSummary = { checked: 0, ok: 0, notFound: 0, removedGuesses: 0, errors: [], blocked: [] };
  const boards = db
    .select()
    .from(companyBoards)
    .all()
    .filter((b) => opts.all || b.checkStatus === "unchecked" || b.checkStatus === "error" || (b.checkedAt ?? "") < staleBefore);

  for (const b of boards) {
    if (summary.blocked.includes(b.ats)) continue;
    const at = now().toISOString();
    try {
      const parsed = parseBoard(b.ats, await http.get(BOARD_URL[b.ats](b.slug)));
      summary.checked++;
      summary.ok++;
      db.update(companyBoards)
        .set({ checkStatus: "ok", checkError: null, checkedAt: at, guessed: false, ...boardCounts(parsed.jobs, config) })
        .where(eq(companyBoards.id, b.id))
        .run();
      if (parsed.name) adoptRealName(db, b.companyId, parsed.name, config.preferences);
    } catch (err) {
      if (err instanceof BlockedError) {
        summary.blocked.push(b.ats);
        markBlocked(db, b.ats, now());
        logCollector(`companies check: ${b.ats} BLOCKED (${err.message}); stopping ${b.ats} until midnight`, now(), opts.logDir);
        continue;
      }
      summary.checked++;
      const message = errorText(err);
      if (/HTTP 404\b/.test(message)) {
        summary.notFound++;
        if (b.guessed) {
          db.delete(companyBoards).where(eq(companyBoards.id, b.id)).run();
          summary.removedGuesses++;
          removeIfEmpty(db, b.companyId);
        } else {
          db.update(companyBoards).set({ checkStatus: "not_found", checkError: null, checkedAt: at }).where(eq(companyBoards.id, b.id)).run();
        }
      } else {
        summary.errors.push(`${b.ats}:${b.slug}: ${message}`);
        db.update(companyBoards).set({ checkStatus: "error", checkError: message, checkedAt: at }).where(eq(companyBoards.id, b.id)).run();
      }
    }
  }
  logCollector(
    `companies check: ${summary.checked} boards, ${summary.ok} ok, ${summary.notFound} not found, ${summary.errors.length} errors` +
      `${summary.blocked.length ? `, BLOCKED ${summary.blocked.join(",")}` : ""}`,
    now(),
    opts.logDir,
  );
  return summary;
}

/**
 * A board told us the company's real name (Greenhouse does). If another Company already has that
 * name, the slug-named one joins it (same normalized name = same company, the usual rule);
 * otherwise a still slug-named Company is renamed.
 */
function adoptRealName(db: Db, companyId: string, name: string, prefs: Preferences): void {
  const norm = normalizeCompany(name);
  if (!norm) return;
  const owner = db.select().from(companyNames).where(eq(companyNames.nameNorm, norm)).get();
  if (owner && owner.companyId !== companyId) {
    mergeCompanies(db, companyId, owner.companyId, prefs);
    return;
  }
  if (!owner) db.insert(companyNames).values({ nameNorm: norm, companyId }).run();
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  const slugNamed = db
    .select()
    .from(companyBoards)
    .where(eq(companyBoards.companyId, companyId))
    .all()
    .some((b) => displayName(b.slug) === company?.name);
  if (company && slugNamed) db.update(companies).set({ name: name.trim() }).where(eq(companies.id, companyId)).run();
}

function removeIfEmpty(db: Db, companyId: string): void {
  const hasBoards = db.select().from(companyBoards).where(eq(companyBoards.companyId, companyId)).get();
  const hasJobs = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.companyId, companyId)).get();
  if (hasBoards || hasJobs) return;
  db.delete(companyNames).where(eq(companyNames.companyId, companyId)).run();
  db.delete(companies).where(eq(companies.id, companyId)).run();
}

// ---- my decisions in the panel ----

function getCompany(db: Db, id: string): Company {
  const c = db.select().from(companies).where(eq(companies.id, id)).get();
  if (!c) throw new CompanyError(`company ${id} not found`);
  return c;
}

export function setFollowed(db: Db, id: string, followed: boolean): void {
  getCompany(db, id);
  db.update(companies).set({ followed }).where(eq(companies.id, id)).run();
}

/** Renames a Company; the new name also becomes one of its names (unless another Company owns it: then Merge). */
export function renameCompany(db: Db, id: string, name: string): void {
  getCompany(db, id);
  const norm = normalizeCompany(name);
  if (!norm) throw new CompanyError("the name is empty");
  const owner = db.select().from(companyNames).where(eq(companyNames.nameNorm, norm)).get();
  if (owner && owner.companyId !== id)
    throw new CompanyError(`"${name}" is already the name of another company — merge them instead`);
  db.transaction((tx) => {
    tx.update(companies).set({ name: name.trim() }).where(eq(companies.id, id)).run();
    if (!owner) tx.insert(companyNames).values({ nameNorm: norm, companyId: id }).run();
  });
}

/**
 * Merge: `sourceId` is the same employer as `targetId`. Its names (as aliases), boards and Jobs
 * move to the target, which stays followed if either was; my manual Local Office wins. The source
 * is removed. Future Postings under any of those names land on the target.
 */
export function mergeCompanies(db: Db, sourceId: string, targetId: string, prefs: Preferences): void {
  if (sourceId === targetId) throw new CompanyError("can't merge a company into itself");
  const source = getCompany(db, sourceId);
  const target = getCompany(db, targetId);
  db.transaction((tx) => {
    tx.update(companyNames).set({ companyId: targetId }).where(eq(companyNames.companyId, sourceId)).run();
    tx.update(companyBoards).set({ companyId: targetId }).where(eq(companyBoards.companyId, sourceId)).run();
    tx.update(jobs).set({ companyId: targetId }).where(eq(jobs.companyId, sourceId)).run();
    const manual = target.localOfficeSource === "manual" ? target : source.localOfficeSource === "manual" ? source : null;
    tx.update(companies)
      .set({
        followed: target.followed || source.followed,
        ...(manual ? { localOffice: manual.localOffice, localOfficeSource: "manual" as const } : {}),
        notes: [target.notes, source.notes].filter(Boolean).join("\n") || null,
      })
      .where(eq(companies.id, targetId))
      .run();
    tx.delete(companies).where(eq(companies.id, sourceId)).run();
  });
  refreshLocalOffice(db, prefs);
}

/** Boards of followed Companies for one ATS: what the Greenhouse/Lever/Ashby collectors fetch. */
export function followedBoards(db: Db, ats: BoardAts): string[] {
  return db
    .select({ slug: companyBoards.slug })
    .from(companyBoards)
    .innerJoin(companies, eq(companies.id, companyBoards.companyId))
    .where(and(eq(companies.followed, true), eq(companyBoards.ats, ats), ne(companyBoards.checkStatus, "not_found")))
    .all()
    .map((r) => r.slug)
    .sort();
}

/** My Local Office correction for a Company (`manual` prevails); null clears it and lets the rules decide. */
export function setCompanyLocalOffice(db: Db, id: string, value: boolean | null, prefs: Preferences): void {
  getCompany(db, id);
  db.update(companies)
    .set(value === null ? { localOffice: false, localOfficeSource: null } : { localOffice: value, localOfficeSource: "manual" })
    .where(eq(companies.id, id))
    .run();
  refreshLocalOffice(db, prefs);
}

/**
 * Recomputes Local Office. A Company has one when one of its Jobs is in my city (`posting`) or I
 * said so (`manual`, which prevails). Each Job then shows: `manual` if the Company's value is my
 * correction; `posting` if the Job itself is in my city; `inherited` if another Job of the Company is.
 * A Job without a Company (a manual Job before tailoring) only has its own city — or my manual
 * correction on the Job itself.
 */
export function refreshLocalOffice(db: Db, prefs: Preferences): void {
  const allJobs = db.select().from(jobs).all();
  const inMyCity = (j: Job) => isMyCity(j.city, prefs);

  for (const c of db.select().from(companies).all()) {
    if (c.localOfficeSource === "manual") continue;
    const has = allJobs.some((j) => j.companyId === c.id && inMyCity(j));
    const next = has ? { localOffice: true, localOfficeSource: "posting" as const } : { localOffice: false, localOfficeSource: null };
    if (next.localOffice !== c.localOffice || next.localOfficeSource !== c.localOfficeSource)
      db.update(companies).set(next).where(eq(companies.id, c.id)).run();
  }

  const byId = new Map(db.select().from(companies).all().map((c) => [c.id, c]));
  for (const j of allJobs) {
    const c = j.companyId ? byId.get(j.companyId) : undefined;
    let next: { localOffice: boolean; localOfficeSource: Job["localOfficeSource"] };
    if (!c) {
      if (j.localOfficeSource === "manual") continue;
      next = inMyCity(j) ? { localOffice: true, localOfficeSource: "posting" } : { localOffice: false, localOfficeSource: null };
    } else if (c.localOfficeSource === "manual") next = { localOffice: c.localOffice, localOfficeSource: "manual" };
    else if (inMyCity(j)) next = { localOffice: true, localOfficeSource: "posting" };
    else if (c.localOffice) next = { localOffice: true, localOfficeSource: "inherited" };
    else next = { localOffice: false, localOfficeSource: null };
    if (next.localOffice !== j.localOffice || next.localOfficeSource !== j.localOfficeSource)
      db.update(jobs).set(next).where(eq(jobs.id, j.id)).run();
  }
}
