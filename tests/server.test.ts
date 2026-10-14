import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { markSuccess } from "../src/collector-state.js";
import { loadConfig } from "../src/config.js";
import { loadBaseCv } from "../src/cv/schema.js";
import { openDb } from "../src/db/index.js";
import { jobs, postings } from "../src/db/schema.js";
import { ingest, type PostingIn } from "../src/ingest.js";
import type { ClaudeRunner } from "../src/llm.js";
import { createApp } from "../src/server.js";
import type { TailoringOutput } from "../src/tailoring.js";
import { TechMatcher } from "../src/tech.js";

const cv = loadBaseCv();
const config = loadConfig();
const matcher = TechMatcher.load();
const dir = mkdtempSync(join(tmpdir(), "jobpipe-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DESC =
  "Acme is hiring a full stack developer to build web products with React and Node, review code and improve performance.";

function tailored(): TailoringOutput {
  return {
    keywords: ["React", "Node"],
    strong_matches: ["React", "Node"],
    gaps: ["Kafka"],
    summary: "Full-stack JavaScript developer with 7 years building web products with React and Node.",
    experience: cv.experience.map((e) => ({ company: e.company, bullets: e.bullets.slice(0, 3) })),
    cover_letter: "Dear Acme hiring team,\n\nI build web products with React and Node.\n\nNicolas Villanova",
    changes_rationale: [],
    job: { company: "Acme", title: "Full Stack Developer", workplace: "remote", office_city: null, office_days_per_week: null },
  };
}

let n = 0;
function posting(over: Partial<PostingIn> = {}): PostingIn {
  const externalId = over.externalId ?? String(++n);
  return {
    source: "gupy", externalId, url: `https://acme.example/${externalId}`, applyUrl: `https://acme.example/${externalId}/apply`,
    company: `Acme ${externalId}`, title: "Full Stack Developer", location: null, workplace: "remote",
    salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null,
    description: DESC, postedAt: null, ...over,
  };
}

function setup() {
  const db = openDb(":memory:");
  const outputDir = join(dir, `out-${Math.random()}`);
  const app = createApp({ db, config, cv, matcher, outputDir, logDir: join(dir, "logs") });
  /** A generated Job with its analysis.json (no PDF yet). */
  const generated = (over: Partial<PostingIn> = {}, extra: Partial<typeof jobs.$inferInsert> = {}) => {
    const p = posting(over);
    ingest(db, [p], config.dedupe);
    const id = db.select({ id: postings.jobId }).from(postings).where(eq(postings.externalId, p.externalId)).get()!.id;
    db.update(jobs).set({ status: "generated", score: 80, ...extra }).where(eq(jobs.id, id)).run();
    mkdirSync(join(outputDir, id), { recursive: true });
    writeFileSync(join(outputDir, id, "analysis.json"), JSON.stringify(tailored()));
    writeFileSync(join(outputDir, id, "cover_letter.md"), tailored().cover_letter);
    return id;
  };
  const job = (id: string) => db.select().from(jobs).where(eq(jobs.id, id)).get();
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-jobpipe": "1" }) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { db, app, outputDir, generated, job, send };
}

const editsFrom = (t: TailoringOutput) => ({ summary: t.summary, bullets: t.experience.map((e) => e.bullets), coverLetter: t.cover_letter });

describe("review API", () => {
  it("lists generated Jobs with Preferred Jobs first", async () => {
    const { generated, app } = setup();
    const remote = generated({}, { score: 90 });
    const preferred = generated({}, { score: 72, localOffice: true, localOfficeSource: "posting", workplace: "hybrid", officeDays: 2 });
    const list = (await (await app.request("/api/jobs")).json()) as { id: string; preferred: boolean }[];
    expect(list.map((j) => j.id)).toEqual([preferred, remote]);
    expect(list[0]!.preferred).toBe(true);
  });

  it("refuses state changes without the panel header", async () => {
    const { generated, send, job } = setup();
    const id = generated();
    const res = await send("POST", `/api/jobs/${id}/applied`, undefined, {});
    expect(res.status).toBe(403);
    expect(job(id)!.status).toBe("generated");
  });

  it("rejects an edit that invents a technology, saving nothing", async () => {
    const { generated, send, outputDir } = setup();
    const id = generated();
    const before = readFileSync(join(outputDir, id, "analysis.json"), "utf8");
    const edits = editsFrom(tailored());
    edits.bullets[0]![0] = "Built event-driven services with Kafka.";
    const res = await send("PUT", `/api/jobs/${id}/edits`, edits);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.error).toMatch(/cv\/base\.yaml/);
    expect(body.details.join()).toContain("Kafka");
    expect(readFileSync(join(outputDir, id, "analysis.json"), "utf8")).toBe(before);
  });

  it("saves a valid edit, re-renders the PDF and serves it", async () => {
    const { generated, send, outputDir, app, job } = setup();
    const id = generated({}, { status: "blocked", guardErrors: ["old error"] });
    const edits = editsFrom(tailored());
    edits.summary = "Full-stack JavaScript developer building web products with React and Node.";
    edits.coverLetter = "Dear Acme hiring team,\n\nI build React and Node products.\n\nNicolas Villanova";
    const res = await send("PUT", `/api/jobs/${id}/edits`, edits);
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(outputDir, id, "analysis.json"), "utf8"));
    expect(saved.summary).toBe(edits.summary);
    expect(saved.edited_at).toBeTruthy();
    expect(readFileSync(join(outputDir, id, "cover_letter.md"), "utf8")).toContain("React and Node products");
    expect(job(id)).toMatchObject({ status: "generated", guardErrors: null, pageWarning: false });
    const pdf = await app.request(`/api/jobs/${id}/cv.pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
  }, 60_000);

  it("edits only the cover letter of a cover-letter-only job, with no PDF", async () => {
    const { generated, send, outputDir } = setup();
    const id = generated();
    const { summary: _s, experience: _e, changes_rationale: _c, ...letterOnly } = tailored();
    writeFileSync(join(outputDir, id, "analysis.json"), JSON.stringify(letterOnly));
    const detail = (await (await send("GET", `/api/jobs/${id}`)).json()) as { parts: { cv: boolean; coverLetter: boolean } };
    expect(detail.parts).toEqual({ cv: false, coverLetter: true });

    expect((await send("PUT", `/api/jobs/${id}/edits`, { summary: "x" })).status).toBe(409);
    const res = await send("PUT", `/api/jobs/${id}/edits`, { coverLetter: "Dear Acme hiring team,\n\nShort and true.\n\nNicolas Villanova" });
    expect(res.status).toBe(200);
    expect(readFileSync(join(outputDir, id, "cover_letter.md"), "utf8")).toContain("Short and true");
    expect(existsSync(join(outputDir, id, "analysis.json"))).toBe(true);
    expect((await send("GET", `/api/jobs/${id}/cv.pdf`)).status).toBe(404);
  });

  it("discards, marks as applied and corrects Local Office", async () => {
    const { generated, send, job } = setup();
    const a = generated();
    const b = generated({ company: "Other" });
    await send("POST", `/api/jobs/${a}/discard`, { reason: "salary too low" });
    expect(job(a)).toMatchObject({ status: "discarded", discardReason: "salary too low" });
    await send("POST", `/api/jobs/${b}/applied`);
    expect(job(b)!.status).toBe("applied");
    expect(job(b)!.appliedAt).toBeTruthy();
    const applied = (await (await send("GET", "/api/jobs?view=applied")).json()) as { id: string }[];
    expect(applied.map((j) => j.id)).toEqual([b]);
    const review = (await (await send("GET", "/api/jobs")).json()) as { id: string }[];
    expect(review.map((j) => j.id)).not.toContain(b);

    await send("PUT", `/api/jobs/${b}/local-office`, { value: true });
    expect(job(b)).toMatchObject({ localOffice: true, localOfficeSource: "manual" });
    await send("PUT", `/api/jobs/${b}/local-office`, { value: null });
    expect(job(b)).toMatchObject({ localOffice: false, localOfficeSource: null });

    await send("POST", `/api/jobs/${b}/undo-applied`);
    expect(job(b)).toMatchObject({ status: "generated", appliedAt: null });
    expect((await send("POST", `/api/jobs/${b}/undo-applied`)).status).toBe(409);
  });

  it("merges a possible duplicate into the existing Job, which keeps its status", async () => {
    const { db, generated, send, job, outputDir } = setup();
    const existing = generated({ source: "linkedin" }, { status: "applied" });
    const dup = generated({ source: "greenhouse" }, { status: "analysis", analysisCandidateJobId: existing });
    const pairs = (await (await send("GET", "/api/analysis")).json()) as { job: { id: string }; similarity: number }[];
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.similarity).toBe(1);

    expect((await send("POST", `/api/analysis/${dup}/merge`)).status).toBe(200);
    expect(job(dup)).toBeUndefined();
    expect(existsSync(join(outputDir, dup))).toBe(false);
    expect(job(existing)!.status).toBe("applied");
    const sources = db.select({ s: postings.source }).from(postings).where(eq(postings.jobId, existing)).all().map((r) => r.s);
    expect(sources.sort()).toEqual(["greenhouse", "linkedin"]);
    // The employer's ATS (Greenhouse) now provides the description and apply link.
    expect(job(existing)!.applyUrl).toMatch(/apply$/);
    expect(job(existing)!.descriptionPostingId).not.toBe(existing);
  });

  it("keeps a possible duplicate separate: it goes back to the pipeline", async () => {
    const { generated, send, job } = setup();
    const existing = generated();
    const dup = generated({}, { status: "analysis", analysisCandidateJobId: existing });
    await send("POST", `/api/analysis/${dup}/keep`);
    expect(job(dup)).toMatchObject({ status: "scored", analysisCandidateJobId: null });
    expect((await send("POST", `/api/analysis/${existing}/keep`)).status).toBe(409);
  });

  it("regenerates through the LLM wrapper", async () => {
    const db = openDb(":memory:");
    const outputDir = join(dir, "regen");
    const runner: ClaudeRunner = {
      command: process.execPath,
      prefixArgs: [join(process.cwd(), "tests/fixtures/fake-claude.mjs")],
      env: { ...process.env, FAKE_CLAUDE_MODE: "ok", FAKE_CLAUDE_OUTPUT: JSON.stringify(tailored()) },
    };
    const app = createApp({ db, config, cv, matcher, outputDir, runner, logDir: join(dir, "logs") });
    ingest(db, [posting()], config.dedupe);
    const id = db.select().from(jobs).get()!.id;
    const res = await app.request(`/api/jobs/${id}/generate`, { method: "POST", headers: { "x-jobpipe": "1" } });
    expect(((await res.json()) as { status: string }).status).toBe("generated");
    expect(db.select().from(jobs).get()!.status).toBe("generated");
  }, 60_000);

  it("lists the queue: above the threshold first (Preferred, then score), then the rest", async () => {
    const { generated, app } = setup();
    const low = generated({}, { status: "scored", score: 66 });
    const high = generated({}, { status: "scored", score: 90 });
    const preferred = generated({}, { status: "scored", score: 71, localOffice: true, localOfficeSource: "posting", workplace: "hybrid" });
    generated({}, { status: "generated", score: 95 });
    const q = (await (await app.request("/api/queue")).json()) as { threshold: number; jobs: { id: string; aboveThreshold: boolean }[] };
    expect(q.threshold).toBe(config.thresholds.generate);
    expect(q.jobs.map((j) => j.id)).toEqual([preferred, high, low]);
    expect(q.jobs.map((j) => j.aboveThreshold)).toEqual([true, true, false]);
  });

  it("lists companies, follows one and shows prior applications on a job", async () => {
    const { generated, send, job } = setup();
    const first = generated({ company: "Acme" }, { status: "applied" });
    const second = generated({ company: "ACME Ltda.", description: "another opening at the same company" });
    const companyId = job(first)!.companyId!;
    expect(job(second)!.companyId).toBe(companyId);

    const list = (await (await send("GET", "/api/companies")).json()) as { id: string; jobs: number; applied: number; followed: boolean }[];
    expect(list.find((c) => c.id === companyId)).toMatchObject({ jobs: 2, applied: 1, followed: false });
    await send("POST", `/api/companies/${companyId}/follow`, { followed: true });
    const after = (await (await send("GET", "/api/companies")).json()) as { id: string; followed: boolean }[];
    expect(after[0]).toMatchObject({ id: companyId, followed: true });

    const detail = (await (await send("GET", `/api/jobs/${second}`)).json()) as { appliedAtCompany: number };
    expect(detail.appliedAtCompany).toBe(1);
    expect((await send("POST", `/api/companies/${companyId}/merge`, { into: companyId })).status).toBe(409);
  });

  it("adds a manual job from the panel: scored, first in the Queue, no LLM call", async () => {
    const { generated, send } = setup();
    generated({}, { status: "scored", score: 95 });
    const res = await send("POST", "/api/jobs/manual", {
      title: "Full Stack Developer", company: "Hand Picked", description: "We build web products with React, Node and Kafka.", workplace: "remote",
    });
    expect(res.status).toBe(200);
    const { jobId, created } = (await res.json()) as { jobId: string; created: boolean };
    expect(created).toBe(true);
    const q = (await (await send("GET", "/api/queue")).json()) as { jobs: { id: string; manual: boolean; aboveThreshold: boolean }[] };
    expect(q.jobs[0]).toMatchObject({ id: jobId, manual: true, aboveThreshold: true });
    const detail = (await (await send("GET", `/api/jobs/${jobId}`)).json()) as { matches: string[]; gaps: string[]; score: number };
    expect(detail.matches).toEqual(expect.arrayContaining(["React", "Node"]));
    expect(detail.gaps).toContain("Kafka");
    expect((await send("POST", "/api/jobs/manual", { description: "  " })).status).toBe(400);
  });

  it("reports collector status", async () => {
    const { db, app } = setup();
    markSuccess(db, "gupy", new Date("2026-10-13T10:00:00Z"), 18);
    const rows = (await (await app.request("/api/collectors")).json()) as { source: string; enabled: boolean; lastCount: number | null }[];
    expect(rows.find((r) => r.source === "gupy")).toMatchObject({ enabled: true, lastCount: 18 });
    expect(rows.find((r) => r.source === "greenhouse")!.enabled).toBe(false);
    expect(rows.some((r) => r.source === "manual")).toBe(false);
  });
});
