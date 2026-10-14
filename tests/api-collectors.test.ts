import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isBlocked } from "../src/collector-state.js";
import { collectApiSources } from "../src/collectors/api.js";
import { parseGupyPage, toGupyPosting } from "../src/collectors/gupy.js";
import { toGreenhousePosting } from "../src/collectors/greenhouse.js";
import { BlockedError, type Http, politeHttp } from "../src/collectors/http.js";
import { toLeverPosting } from "../src/collectors/lever.js";
import { toRemotivePosting } from "../src/collectors/remotive.js";
import { toAshbyPosting } from "../src/collectors/ashby.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { type BoardAts, postings } from "../src/db/schema.js";
import { addBoard, companyFor, setFollowed } from "../src/companies.js";
import { htmlToText } from "../src/html.js";

const logDir = mkdtempSync(join(tmpdir(), "jobpipe-api-"));
afterAll(() => rmSync(logDir, { recursive: true, force: true }));
const NOW = new Date("2026-10-13T12:00:00Z");
const recent = "2026-10-12T10:00:00Z";

const gupyHtml = (jobs: object[]) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialJobList: { data: jobs, pagination: { total: jobs.length } } } } })}</script></html>`;
const gupyJob = { id: 101, name: "Desenvolvedor Full Stack", description: "Vue, Node e MySQL.", careerPageName: "Acme", publishedDate: recent, workplaceType: "hybrid", city: "Porto Alegre", state: "RS", jobUrl: "https://acme.gupy.io/job/eyJqb2JJZCI6MTAxfQ==?jobBoardSource=gupy_portal" };
const ghJob = { id: 7, title: "Backend Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/7", location: { name: "Remote - Brazil" }, content: "&lt;p&gt;Build &lt;b&gt;APIs&lt;/b&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Node&lt;/li&gt;&lt;/ul&gt;", company_name: "Acme Inc", first_published: recent };
const leverJob = { id: "abc", text: "Frontend Engineer", hostedUrl: "https://jobs.lever.co/beta/abc", applyUrl: "https://jobs.lever.co/beta/abc/apply", createdAt: Date.parse(recent), workplaceType: "remote", categories: { location: "São Paulo" }, descriptionPlain: "About us.", lists: [{ text: "You will", content: "<li>Build UIs</li>" }], additionalPlain: "" };
const ashbyJob = { id: "x1", title: "Full-stack Engineer", jobUrl: "https://jobs.ashbyhq.com/gamma/x1", applyUrl: "https://jobs.ashbyhq.com/gamma/x1/application", location: "Remote", isRemote: true, isListed: true, workplaceType: "Remote", descriptionPlain: "React and Node.", publishedAt: recent };
const remotiveJob = { id: 55, url: "https://remotive.com/remote-jobs/software-dev/dev-55", title: "Node Developer", company_name: "Delta", candidate_required_location: "Worldwide", publication_date: recent, description: "<p>Node &amp; React</p>" };

function fakeHttp(routes: Record<string, string | Error>): Http & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string) {
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      const value = key ? routes[key] : new Error(`HTTP 404 from ${url}`);
      if (value instanceof Error) throw value;
      return value!;
    },
  };
}

const base = loadConfig();
const config = {
  ...base,
  sources: {
    ...base.sources,
    gupy: { enabled: true, queries: ["full stack"] },
    greenhouse: { enabled: true },
    lever: { enabled: true },
    ashby: { enabled: true },
    remotive: { ...base.sources.remotive, enabled: true },
  },
};
/** A database whose followed companies have these boards (what the ATS collectors fetch). */
function dbWithBoards(boards: [BoardAts, string][] = [["greenhouse", "acme"], ["greenhouse", "missing"], ["lever", "beta"], ["ashby", "gamma"]]) {
  const db = openDb(":memory:");
  for (const [ats, slug] of boards) {
    const id = companyFor(db, slug, NOW)!;
    addBoard(db, id, ats, slug, "import", NOW);
    setFollowed(db, id, true);
  }
  return db;
}

const routes = {
  "portal.gupy.io": gupyHtml([gupyJob, { ...gupyJob, id: 102, publishedDate: "2025-01-01T00:00:00Z" }]),
  "boards/acme/": JSON.stringify({ jobs: [ghJob] }),
  "postings/beta": JSON.stringify([leverJob]),
  "job-board/gamma": JSON.stringify({ jobs: [ashbyJob, { ...ashbyJob, id: "x2", isListed: false }] }),
  "remotive.com": JSON.stringify({ jobs: [remotiveJob] }),
};

describe("mappers", () => {
  it("Gupy: reads the embedded page data", () => {
    const [p] = parseGupyPage(gupyHtml([gupyJob])).map(toGupyPosting);
    expect(p).toMatchObject({ source: "gupy", externalId: "101", company: "Acme", workplace: "hybrid", location: "Porto Alegre, RS" });
    expect(p?.url).not.toContain("?");
    expect(() => parseGupyPage("<html></html>")).toThrow(/__NEXT_DATA__/);
  });

  it("Greenhouse: unescapes and cleans the HTML description", () => {
    const p = toGreenhousePosting(ghJob, "acme");
    expect(p).toMatchObject({ externalId: "acme/7", company: "Acme Inc", workplace: "remote" });
    expect(p?.description).toBe("Build APIs\n\n- Node");
  });

  it("Lever, Ashby and Remotive", () => {
    expect(toLeverPosting(leverJob, "beta")).toMatchObject({ company: "Beta", workplace: "remote", applyUrl: leverJob.applyUrl });
    expect(toLeverPosting(leverJob, "beta")?.description).toContain("## You will\n- Build UIs");
    expect(toAshbyPosting(ashbyJob, "gamma")).toMatchObject({ company: "Gamma", workplace: "remote" });
    expect(toAshbyPosting({ ...ashbyJob, isListed: false }, "gamma")).toBeNull();
    expect(toRemotivePosting(remotiveJob)).toMatchObject({ workplace: "remote", applyUrl: remotiveJob.url, description: "Node & React" });
  });

  it("htmlToText keeps structure", () => {
    expect(htmlToText("<h2>Role</h2><p>A&nbsp;b</p><ul><li>x</li><li>y</li></ul>")).toBe("## Role\n\nA b\n\n- x\n- y");
  });
});

describe("collectApiSources", () => {
  it("collects every source, filters by window, and keeps going when one target fails", async () => {
    const db = dbWithBoards();
    const out = await collectApiSources(db, config, { http: fakeHttp(routes), now: () => NOW, logDir });
    const by = Object.fromEntries(out.map((s) => [s.source, s]));
    expect(by.gupy).toMatchObject({ status: "ok", created: 1 }); // the 2025 job is outside the window
    expect(by.greenhouse).toMatchObject({ status: "ok", created: 1 });
    expect(by.greenhouse?.errors.join()).toContain("missing");
    expect(by.lever).toMatchObject({ created: 1 });
    expect(by.ashby).toMatchObject({ created: 1 }); // unlisted job dropped
    expect(by.remotive).toMatchObject({ created: 1 });
    expect(db.select().from(postings).all()).toHaveLength(5);
  });

  it("stops a blocked source until midnight without affecting the others", async () => {
    const db = dbWithBoards();
    const http = fakeHttp({ ...routes, "boards/acme/": new BlockedError("HTTP 429 from boards-api.greenhouse.io") });
    const out = await collectApiSources(db, config, { http, now: () => NOW, logDir });
    expect(out.find((s) => s.source === "greenhouse")?.status).toBe("blocked");
    expect(out.find((s) => s.source === "lever")?.status).toBe("ok");
    expect(isBlocked(db, "greenhouse", NOW)).toBe(true);
    expect(http.calls.some((u) => u.includes("boards/missing"))).toBe(false); // stopped at the block

    const again = await collectApiSources(db, config, { http: fakeHttp(routes), now: () => NOW, logDir, sources: ["greenhouse"] });
    expect(again[0]?.status).toBe("skipped");
  });

  it("respects Remotive's request limit and skips sources with nothing configured", async () => {
    const db = dbWithBoards();
    await collectApiSources(db, config, { http: fakeHttp(routes), now: () => NOW, logDir, sources: ["remotive"] });
    const soon = new Date(NOW.getTime() + 3_600_000);
    const again = await collectApiSources(db, config, { http: fakeHttp(routes), now: () => soon, logDir, sources: ["remotive"] });
    expect(again[0]?.status).toBe("skipped");
    const none = await collectApiSources(dbWithBoards([]), config, { http: fakeHttp(routes), now: () => NOW, logDir, sources: ["lever"] });
    expect(none[0]?.status).toBe("disabled");
  });
});

describe("politeHttp", () => {

  const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("turns 429/403 and captcha pages into BlockedError, other failures into plain errors", async () => {
    await expect(politeHttp(0, 1000, respond(429, "")).get("https://x.example/a")).rejects.toBeInstanceOf(BlockedError);
    await expect(politeHttp(0, 1000, respond(403, "")).get("https://x.example/a")).rejects.toBeInstanceOf(BlockedError);
    await expect(politeHttp(0, 1000, respond(200, "<html>Please solve the captcha</html>")).get("https://x.example/a")).rejects.toBeInstanceOf(BlockedError);
    const notFound = politeHttp(0, 1000, respond(404, "nope")).get("https://x.example/a");
    await expect(notFound).rejects.not.toBeInstanceOf(BlockedError);
    await expect(politeHttp(0, 1000, respond(200, '{"ok":true}')).get("https://x.example/a")).resolves.toBe('{"ok":true}');
  });
});
