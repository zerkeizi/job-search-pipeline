import { existsSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { addManualJobFromFile as addManualJob } from "../src/collectors/manual.js";
import { loadConfig } from "../src/config.js";
import { inspectPdf } from "../src/cv/pdf-inspect.js";
import { loadBaseCv } from "../src/cv/schema.js";
import { openDb } from "../src/db/index.js";
import { jobs } from "../src/db/schema.js";
import { cvFileName, generate, pendingJobIds } from "../src/generate.js";
import type { ClaudeRunner } from "../src/llm.js";
import type { TailoringOutput } from "../src/tailoring.js";
import { TechMatcher } from "../src/tech.js";
import { UsageLog } from "../src/usage.js";

const cv = loadBaseCv();
const config = loadConfig();
const matcher = TechMatcher.load();
const dir = mkdtempSync(join(tmpdir(), "jobpipe-generate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function tailored(overrides: Partial<TailoringOutput> = {}): TailoringOutput {
  return {
    keywords: ["React", "Node"],
    strong_matches: ["React", "Node"],
    gaps: ["Kafka"],
    summary: "Full-stack JavaScript developer with 7 years building web products with React and Node.",
    experience: cv.experience.map((e) => ({ company: e.company, bullets: e.bullets.slice(0, 3) })),
    cover_letter: "Dear Acme hiring team,\n\nI build web products with React and Node.\n\nNicolas Villanova",
    changes_rationale: [],
    job: { company: "Acme Tecnologia Ltda.", title: "Senior Full-stack Developer", workplace: "hybrid", office_city: "Porto Alegre", office_days_per_week: 2 },
    ...overrides,
  };
}

function fake(mode: string, output?: TailoringOutput): ClaudeRunner {
  return {
    command: process.execPath,
    prefixArgs: [join(process.cwd(), "tests/fixtures/fake-claude.mjs")],
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_OUTPUT: JSON.stringify(output ?? {}) },
  };
}

function setup(text: string) {
  const db = openDb(":memory:");
  const file = join(dir, `${Math.random()}.txt`);
  writeFileSync(file, text);
  const { jobId } = addManualJob(db, file, "https://jobs.example/acme/1");
  const deps = { db, config, cv, matcher, outputDir: join(dir, "out"), usage: new UsageLog("generate", join(dir, "logs")) };
  return { db, jobId, deps };
}

describe("jobpipe add → generate", () => {
  it("adding the same text twice returns the same job", () => {
    const { db } = setup("Senior React developer at Acme");
    const file = join(dir, "same.txt");
    writeFileSync(file, "Same job text");
    const first = addManualJob(db, file);
    expect(addManualJob(db, file)).toMatchObject({ jobId: first.jobId, created: false, existing: "same_text" });
  });

  it("generates a one-page CV, cover letter and analysis, and fills in the job facts", async () => {
    const { db, jobId, deps } = setup("Acme is hiring a Senior Full-stack Developer (React, Node, Kafka). Hybrid, Porto Alegre, 2 days/week.");
    expect(pendingJobIds(db, config, 10)).toEqual([jobId]);

    const [outcome] = await generate([jobId], { ...deps, runner: fake("ok", tailored()) });
    expect(outcome?.status).toBe("generated");
    if (outcome?.status !== "generated") return;

    expect(outcome.pdfPath!.endsWith(cvFileName(cv, "Acme Tecnologia Ltda."))).toBe(true);
    expect((await inspectPdf(outcome.pdfPath!)).pages).toBe(1);
    expect(readFileSync(join(deps.outputDir, jobId, "cover_letter.md"), "utf8")).toContain("Dear Acme");
    expect(existsSync(join(deps.outputDir, jobId, "analysis.json"))).toBe(true);

    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(job).toMatchObject({ status: "generated", company: "Acme Tecnologia Ltda.", companyNorm: "acme tecnologia", workplace: "hybrid", city: "Porto Alegre", officeDays: 2 });
    expect(job.gaps).toContain("Kafka");
    expect(pendingJobIds(db, config, 10)).toEqual([]);
  }, 120_000);

  it("writes only the cover letter, then adds the CV later without touching the letter", async () => {
    const { db, jobId, deps } = setup("Acme (Gupy) wants React and Node. Remote.");
    const full = tailored();
    const letterOnly = { keywords: full.keywords, strong_matches: full.strong_matches, gaps: full.gaps, cover_letter: full.cover_letter, job: full.job };
    const [first] = await generate([jobId], { ...deps, runner: fake("ok", letterOnly as TailoringOutput) }, "cover_letter");
    expect(first).toMatchObject({ status: "generated", mode: "cover_letter", pdfPath: null });
    const dir = join(deps.outputDir, jobId);
    expect(readFileSync(join(dir, "cover_letter.md"), "utf8")).toContain("Dear Acme");
    expect(readdirSync(dir).some((f) => f.endsWith(".pdf"))).toBe(false);
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status).toBe("generated");

    const { cover_letter: _letter, ...cvOnly } = full;
    const [second] = await generate([jobId], { ...deps, runner: fake("ok", cvOnly as TailoringOutput) }, "cv");
    expect(second).toMatchObject({ status: "generated", mode: "cv" });
    expect(readdirSync(dir).filter((f) => f.endsWith(".pdf"))).toHaveLength(1);
    const analysis = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf8"));
    expect(analysis.cover_letter).toBe(full.cover_letter);
    expect(analysis.experience).toHaveLength(cv.experience.length);
  }, 120_000);

  it("blocks the job when the guard finds an invented technology", async () => {
    const { db, jobId, deps } = setup("Acme wants Kafka.");
    const bad = tailored();
    bad.experience[0]!.bullets[0] = "Built event-driven services with Kafka.";
    const [outcome] = await generate([jobId], { ...deps, runner: fake("ok", bad) });
    expect(outcome?.status).toBe("blocked");
    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(job.status).toBe("blocked");
    expect(job.guardErrors?.join()).toContain("Kafka");
  }, 60_000);

  it("stops at a quota error and leaves the job pending", async () => {
    const { db, jobId, deps } = setup("Another job.");
    const outcomes = await generate([jobId], { ...deps, runner: fake("quota") });
    expect(outcomes).toEqual([{ jobId, status: "quota_exhausted" }]);
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.status).toBe("scored");
  }, 60_000);
});
