import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isBlocked, nextMidnight, windowHours } from "../src/collector-state.js";
import { collectJobspy, runSidecar, type SidecarRunner } from "../src/collectors/jobspy.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { jobs, postings } from "../src/db/schema.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "jobpipe-jobspy-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  delete process.env.FAKE_SIDECAR_MODE;
  delete process.env.FAKE_SIDECAR_INPUTS;
});

const fake: SidecarRunner = { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/fake-sidecar.mjs")] };
const base = loadConfig();
const config = {
  ...base,
  sources: { ...base.sources, jobspy: { ...base.sources.jobspy, searches: base.sources.jobspy.searches.slice(0, 2) } },
};
const noSleep = async () => {};
const at = (iso: string) => () => new Date(iso);

function run(mode: string, opts: Partial<Parameters<typeof collectJobspy>[2]> = {}, db = openDb(":memory:")) {
  process.env.FAKE_SIDECAR_MODE = mode;
  const inputs = join(tmp(), "inputs.jsonl");
  process.env.FAKE_SIDECAR_INPUTS = inputs;
  const summary = collectJobspy(db, config, { runner: fake, sleep: noSleep, logDir: tmp(), ...opts });
  return { db, summary, inputs: () => readFileSync(inputs, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

describe("runSidecar", () => {
  const input = { sites: ["indeed" as const], search_term: "node", google_search_term: "node jobs", location: "Brazil", country_indeed: "Brazil", is_remote: false, hours_old: 48, results_wanted: 5, fetch_description: true, description_format: "markdown" as const };

  it("handles the three exit codes", async () => {
    process.env.FAKE_SIDECAR_MODE = "ok";
    expect((await runSidecar(input, fake, 5000)).exitCode).toBe(0);
    process.env.FAKE_SIDECAR_MODE = "error";
    expect((await runSidecar(input, fake, 5000)).error).toContain("boom");
    process.env.FAKE_SIDECAR_MODE = "blocked";
    const blocked = await runSidecar({ ...input, sites: ["linkedin", "indeed"] }, fake, 5000);
    expect(blocked).toMatchObject({ exitCode: 2, blocked: ["linkedin"] });
    expect(blocked.records.length).toBeGreaterThan(0); // partial results from the other sites are kept
  });

  it("kills the process on timeout", async () => {
    process.env.FAKE_SIDECAR_MODE = "hang";
    expect((await runSidecar(input, fake, 300)).error).toContain("timed out");
  });
});

describe("collectJobspy", () => {
  it("stores valid postings, drops invalid ones and maps fields", async () => {
    const { db, summary } = run("ok");
    const s = await summary;
    // 2 searches × 4 sites × 2 jobs; job #1 of every site links to the same Greenhouse URL → one Job.
    expect(s).toMatchObject({ invalid: 4, blocked: [], errors: [] });
    expect(s.created + s.linked).toBe(16);
    expect(s.linked).toBeGreaterThanOrEqual(7);
    const p = db.select().from(postings).all().find((r) => r.externalId?.startsWith("linkedin-") && r.externalId.endsWith("-1"))!;
    expect(p).toMatchObject({ source: "linkedin", applyUrl: "https://boards.greenhouse.io/acme/jobs/1", company: "Acme" });
    expect(db.select().from(jobs).all().every((j) => j.status === "new")).toBe(true);
  });

  it("only refreshes jobs it has already seen", async () => {
    const db = openDb(":memory:");
    await run("ok", {}, db).summary;
    const second = await run("ok", {}, db).summary;
    expect(second).toMatchObject({ created: 0, linked: 0, seenAgain: 16 });
  });

  it("blocks a site until midnight, keeps the other sites' results and skips it on the next run", async () => {
    const now = at("2026-10-13T10:00:00");
    const first = run("blocked", { now });
    const s = await first.summary;
    expect(s.blocked).toEqual(["linkedin"]);
    expect(first.inputs()[1].sites).not.toContain("linkedin"); // dropped for the remaining searches
    expect(isBlocked(first.db, "linkedin", now())).toBe(true);
    expect(isBlocked(first.db, "linkedin", nextMidnight(now()))).toBe(false);

    const again = run("ok", { now }, first.db);
    expect((await again.summary).skipped).toEqual(["linkedin"]);
    expect(again.inputs()[0].sites).not.toContain("linkedin");

    const forced = run("ok", { now, force: true }, first.db);
    await forced.summary;
    expect(forced.inputs()[0].sites).toContain("linkedin");
  });

  it("uses the max window on the first run and the time since the last success afterwards", async () => {
    const db = openDb(":memory:");
    const first = run("ok", { now: at("2026-10-13T10:00:00") }, db);
    await first.summary;
    expect(first.inputs()[0].hours_old).toBe(config.sources.jobspy.max_hours_old);
    expect(windowHours(db, "indeed", new Date("2026-10-14T10:00:00"), 12, 168)).toBe(36);
    expect(windowHours(db, "indeed", new Date("2026-11-30T10:00:00"), 12, 168)).toBe(168);
  });

  it("records an error without crashing and doesn't mark the sites as successful", async () => {
    const { db, summary } = run("error");
    const s = await summary;
    expect(s.errors).toHaveLength(2);
    expect(windowHours(db, "indeed", new Date(), 12, 168)).toBe(168);
  });
});
