import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { isBlocked } from "../src/collector-state.js";
import {
  boardCounts,
  checkBoards,
  CompanyError,
  companyFor,
  followedBoards,
  importBoards,
  mergeCompanies,
  parseBoardRef,
  renameCompany,
  setFollowed,
} from "../src/companies.js";
import { BlockedError, type Http } from "../src/collectors/http.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { companies, companyBoards, jobs } from "../src/db/schema.js";
import { ingest, type PostingIn } from "../src/ingest.js";

const config = loadConfig();
const NOW = new Date("2026-10-14T12:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "jobpipe-companies-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function posting(over: Partial<PostingIn> = {}): PostingIn {
  const externalId = over.externalId ?? String(++n);
  return {
    source: "linkedin", externalId, url: `https://linkedin.example/${externalId}`, applyUrl: null,
    company: "Acme", title: "Full Stack Developer", location: null, workplace: "remote",
    salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null,
    description: `Job ${externalId} with React and Node`, postedAt: null, ...over,
  };
}

const boardsOf = (db: ReturnType<typeof openDb>) =>
  db.select().from(companyBoards).all().map((b) => `${b.ats}:${b.slug}:${b.checkStatus}`).sort();
const companyNamed = (db: ReturnType<typeof openDb>, name: string) => db.select().from(companies).where(eq(companies.name, name)).get();

function fakeHttp(routes: Record<string, string | Error>): Http & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string) {
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      const value = key === undefined ? new Error(`HTTP 404 from ${url}`) : routes[key]!;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

describe("companies from collected jobs", () => {
  it("links Jobs to one Company per normalized name and discovers boards from links", () => {
    const db = openDb(":memory:");
    ingest(db, [
      posting({ company: "Acme Tecnologia Ltda.", applyUrl: "https://jobs.lever.co/acme/abc-123/apply", description: "first job text here" }),
      posting({ company: "ACME TECNOLOGIA", applyUrl: "https://boards.greenhouse.io/acmetech/jobs/42", description: "second job, other text" }),
      posting({ source: "ashby", externalId: "beta/xyz", company: "Beta", url: "https://example.com/beta", description: "beta job" }),
      posting({ company: "Gamma", applyUrl: "https://www.gamma.com/careers?gh_jid=77", description: "gamma job" }),
    ], config.dedupe, NOW);

    const all = db.select().from(jobs).all();
    expect(all.every((j) => j.companyId)).toBe(true);
    const acme = all.filter((j) => j.company.toLowerCase().startsWith("acme"));
    expect(new Set(acme.map((j) => j.companyId)).size).toBe(1);
    // A gh_jid link on the company's own site doesn't say which board: nothing to discover.
    expect(boardsOf(db)).toEqual(["ashby:beta:unchecked", "greenhouse:acmetech:unchecked", "lever:acme:unchecked"]);
    expect(db.select().from(companyBoards).all().every((b) => b.discoveredFrom === "posting")).toBe(true);
  });
});

describe("import", () => {
  it("reads board URLs, ats:slug and bare slugs", () => {
    expect(parseBoardRef("https://boards.greenhouse.io/Stripe")).toEqual({ ats: "greenhouse", slug: "stripe" });
    expect(parseBoardRef("job-boards.greenhouse.io/acme/jobs/1")).toEqual({ ats: "greenhouse", slug: "acme" });
    expect(parseBoardRef("https://boards.greenhouse.io/embed/job_board?for=acme")).toEqual({ ats: "greenhouse", slug: "acme" });
    expect(parseBoardRef("jobs.lever.co/plaid/123")).toEqual({ ats: "lever", slug: "plaid" });
    expect(parseBoardRef("https://jobs.ashbyhq.com/ramp")).toEqual({ ats: "ashby", slug: "ramp" });
    expect(parseBoardRef("ashby: Linear")).toEqual({ ats: "ashby", slug: "linear" });
    expect(parseBoardRef("nubank")).toEqual({ slug: "nubank" });
    expect(parseBoardRef("# a comment")).toBeNull();
    expect(parseBoardRef("not a board, really")).toBeNull();
  });

  it("adds boards (bare slugs on all three ATSs, as guesses) and skips known ones", () => {
    const db = openDb(":memory:");
    const file = join(dir, "list.txt");
    writeFileSync(file, "# my list\nhttps://jobs.lever.co/plaid\nnubank\n\nwhat is this?\njobs.lever.co/plaid\n");
    expect(importBoards(db, file, NOW)).toEqual({ added: 2, known: 1, invalid: ["what is this?"] });
    expect(boardsOf(db)).toEqual([
      "ashby:nubank:unchecked", "greenhouse:nubank:unchecked", "lever:nubank:unchecked", "lever:plaid:unchecked",
    ]);
    expect(db.select().from(companies).all().map((c) => c.name).sort()).toEqual(["Nubank", "Plaid"]);
  });
});

describe("check", () => {
  const gh = (company: string, jobs: { title: string; location: string }[]) =>
    JSON.stringify({ jobs: jobs.map((j, i) => ({ id: i, title: j.title, location: { name: j.location }, company_name: company })) });

  it("counts open, dev and fitting jobs; drops wrong guesses; learns the real name", async () => {
    const db = openDb(":memory:");
    const file = join(dir, "check.txt");
    writeFileSync(file, "nubank\nlever:ghost\n");
    importBoards(db, file, NOW);
    const http = fakeHttp({
      "boards/nubank/jobs": gh("Nubank", [
        { title: "Senior Software Engineer", location: "São Paulo, Brazil" },
        { title: "Software Engineer", location: "Berlin" },
        { title: "Junior Developer", location: "Remote" },
        { title: "Account Executive", location: "Remote" },
      ]),
    });
    const s = await checkBoards(db, config, http, { now: () => NOW, logDir: dir });
    expect(s).toMatchObject({ checked: 4, ok: 1, notFound: 3, removedGuesses: 2 });
    expect(boardsOf(db)).toEqual(["greenhouse:nubank:ok", "lever:ghost:not_found"]);
    const board = db.select().from(companyBoards).where(eq(companyBoards.slug, "nubank")).get()!;
    expect(board).toMatchObject({ openJobs: 4, devJobs: 2, fitJobs: 1, guessed: false });
    expect(http.calls).toHaveLength(4); // one request per board

    // Checked boards aren't fetched again until they're stale (or --all).
    const again = await checkBoards(db, config, fakeHttp({}), { now: () => NOW, logDir: dir });
    expect(again.checked).toBe(0);
  });

  it("joins a slug-named Company to the existing one with the board's real name", async () => {
    const db = openDb(":memory:");
    ingest(db, [posting({ company: "Acme Tecnologia S.A." })], config.dedupe, NOW);
    const file = join(dir, "acme.txt");
    writeFileSync(file, "greenhouse:acmetec\n");
    importBoards(db, file, NOW);
    expect(db.select().from(companies).all()).toHaveLength(2);
    await checkBoards(db, config, fakeHttp({ "boards/acmetec/jobs": gh("Acme Tecnologia", [{ title: "Developer", location: "Remote" }]) }), { now: () => NOW, logDir: dir });
    const all = db.select().from(companies).all();
    expect(all).toHaveLength(1);
    expect(db.select().from(companyBoards).get()!.companyId).toBe(all[0]!.id);
  });

  it("stops an ATS at a block, like the collectors", async () => {
    const db = openDb(":memory:");
    const file = join(dir, "blocked.txt");
    writeFileSync(file, "greenhouse:a\ngreenhouse:b\nlever:c\n");
    importBoards(db, file, NOW);
    const http = fakeHttp({ "boards/a/": new BlockedError("HTTP 429"), "postings/c": "[]" });
    const s = await checkBoards(db, config, http, { now: () => NOW, logDir: dir });
    expect(s.blocked).toEqual(["greenhouse"]);
    expect(http.calls.some((u) => u.includes("boards/b/"))).toBe(false);
    expect(isBlocked(db, "greenhouse", NOW)).toBe(true);
    expect(boardsOf(db)).toContain("lever:c:ok");
  });

  it("counts remote, Brazil/LatAm and my-city roles as fitting", () => {
    const c = boardCounts(
      [
        { title: "Backend Engineer", location: "Remote - LATAM", remote: false },
        { title: "Frontend Developer", location: "Porto Alegre", remote: false },
        { title: "Software Engineer", location: "New York", remote: false },
        { title: "Software Engineer", location: "Anywhere", remote: true },
      ],
      config,
    );
    expect(c).toEqual({ openJobs: 4, devJobs: 4, fitJobs: 3 });
  });
});

describe("my decisions", () => {
  it("merges two names of one employer; later Postings under the alias land on it", () => {
    const db = openDb(":memory:");
    ingest(db, [posting({ company: "Nubank", description: "one" }), posting({ company: "Nu Pagamentos S.A.", description: "two" })], config.dedupe, NOW);
    const nubank = companyNamed(db, "Nubank")!;
    const nu = companyNamed(db, "Nu Pagamentos S.A.")!;
    setFollowed(db, nu.id, true);
    mergeCompanies(db, nu.id, nubank.id, config.preferences);

    expect(db.select().from(companies).all()).toHaveLength(1);
    expect(companyNamed(db, "Nubank")!.followed).toBe(true);
    expect(new Set(db.select().from(jobs).all().map((j) => j.companyId))).toEqual(new Set([nubank.id]));
    ingest(db, [posting({ company: "NU PAGAMENTOS", description: "three" })], config.dedupe, NOW);
    expect(db.select().from(jobs).all().every((j) => j.companyId === nubank.id)).toBe(true);
  });

  it("renames, refusing a name that belongs to another company", () => {
    const db = openDb(":memory:");
    const a = companyFor(db, "Acme", NOW)!;
    companyFor(db, "Beta", NOW);
    renameCompany(db, a, "Acme Corp Brasil");
    expect(companyFor(db, "acme corp brasil", NOW)).toBe(a);
    expect(companyFor(db, "Acme", NOW)).toBe(a);
    expect(() => renameCompany(db, a, "BETA")).toThrow(CompanyError);
  });

  it("collects only boards of followed companies that exist", async () => {
    const db = openDb(":memory:");
    const file = join(dir, "follow.txt");
    writeFileSync(file, "lever:one\nlever:two\ngreenhouse:three\n");
    importBoards(db, file, NOW);
    await checkBoards(db, config, fakeHttp({ "postings/one": "[]" }), { now: () => NOW, logDir: dir });
    for (const c of db.select().from(companies).all()) setFollowed(db, c.id, true);
    expect(followedBoards(db, "lever")).toEqual(["one"]);
    expect(followedBoards(db, "greenhouse")).toEqual([]);
  });
});
