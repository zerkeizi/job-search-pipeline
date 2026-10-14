import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { markBlocked, markSuccess } from "../src/collector-state.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { jobs } from "../src/db/schema.js";
import { ingest, type PostingIn } from "../src/ingest.js";
import type { LlmUsage, Quota } from "../src/llm.js";
import { computeStats, formatStats, readUsage, resetTime } from "../src/stats.js";
import { UsageLog } from "../src/usage.js";

const dir = mkdtempSync(join(tmpdir(), "jobpipe-stats-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const usage = (out: number, cost: number): LlmUsage => ({
  model: "claude-sonnet-5-5", inputTokens: 2, cacheWriteTokens: 4000, cacheReadTokens: 1000, outputTokens: out, equivalentCostUsd: cost,
});
const quota = (used5h: number): Quota => ({
  status: "allowed",
  fiveHour: { used: used5h, resetsAt: new Date(2026, 9, 13, 19, 40) },
  sevenDay: { used: 0.04, resetsAt: new Date(2026, 9, 20, 9, 0) },
});

function posting(externalId: string): PostingIn {
  return {
    source: "gupy", externalId, url: `https://x.example/${externalId}`, applyUrl: null, company: `C${externalId}`, title: "Dev",
    location: null, workplace: "remote", salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null,
    description: `Job ${externalId}`, postedAt: null,
  };
}

describe("stats", () => {
  it("sums this month's usage logs and keeps the last quota reading", () => {
    const logs = join(dir, "logs");
    const run = (at: Date, calls: [number, number, number][]) => {
      const log = new UsageLog("generate", logs, () => at);
      for (const [out, cost, used] of calls) log.record(usage(out, cost), quota(used), "job1");
      log.finish();
    };
    run(new Date(2026, 9, 13, 14, 0), [[3000, 0.05, 0.2], [2000, 0.04, 0.3]]);
    run(new Date(2026, 9, 14, 9, 0), [[1000, 0.02, 0.1]]);
    run(new Date(2026, 8, 30, 9, 0), [[9999, 9.99, 0.9]]); // last month: ignored
    writeFileSync(join(logs, "2026-10-12_collector.log"), "not a usage log\n");

    const { calls, lastQuota } = readUsage(logs, "2026-10");
    expect(calls.map((c) => c.output)).toEqual([3000, 2000, 1000]);
    expect(lastQuota).toMatchObject({ at: "2026-10-14 09:00", fiveHourRemaining: "90%", sevenDayRemaining: "96%", sevenDayResets: "20/10 09:00" });

    const db = openDb(":memory:");
    const s = computeStats(db, logs, new Date(2026, 9, 14, 12, 0));
    expect(s.usage).toMatchObject({ calls: 3, output: 6000, cacheWrite: 12000, byStage: { generate: 3 } });
    expect(s.usage.costUsd).toBeCloseTo(0.11);
  });

  it("counts Jobs by status and this month's activity, and lists blocked collectors", () => {
    const db = openDb(":memory:");
    const now = new Date(2026, 9, 14, 12, 0);
    ingest(db, [posting("a"), posting("b"), posting("c")], loadConfig().dedupe, now);
    ingest(db, [posting("old")], loadConfig().dedupe, new Date(2026, 8, 20));
    const [a] = db.select().from(jobs).all();
    db.update(jobs).set({ status: "applied", appliedAt: now.toISOString() }).where(eq(jobs.id, a!.id)).run();
    markSuccess(db, "gupy", now, 12);
    markBlocked(db, "linkedin", now);

    const s = computeStats(db, join(dir, "none"), now);
    expect(s.byStatus).toMatchObject({ new: 3, applied: 1, generated: 0 });
    expect(s.newThisMonth).toBe(3);
    expect(s.appliedThisMonth).toBe(1);
    expect(s.collectors.find((c) => c.source === "linkedin")!.blockedUntil).not.toBeNull();
    const text = formatStats(s, now);
    expect(text).toContain("BLOCKED until");
    expect(text).toContain("(12 postings)");
    expect(text).toContain("quota: no reading this month");
  });

  it("says when a quota window has reset since the last reading", () => {
    expect(resetTime("2026-10-13 17:08", "19:40")).toEqual(new Date(2026, 9, 13, 19, 40));
    expect(resetTime("2026-12-30 10:00", "02/01 09:00")).toEqual(new Date(2027, 0, 2, 9, 0));
    const s = computeStats(openDb(":memory:"), join(dir, "logs"), new Date(2026, 9, 14, 12, 0));
    expect(formatStats(s, new Date(2026, 9, 14, 12, 0))).toMatch(/5h reset since \(was 90% left\) · 7d 96% left/);
  });
});
