import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addManualJob } from "../src/collectors/manual.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { jobs, postings } from "../src/db/schema.js";
import { ingest, type PostingIn } from "../src/ingest.js";

const config = loadConfig();
const collected = (over: Partial<PostingIn> = {}): PostingIn => ({
  source: "linkedin", externalId: "li-1", url: "https://linkedin.example/1", applyUrl: "https://jobs.lever.co/acme/abc-123",
  company: "Acme", title: "Full Stack Developer", location: null, workplace: "remote", salaryMin: null, salaryMax: null,
  salaryCurrency: null, salaryInterval: null, description: "Collected text", postedAt: null, ...over,
});

describe("manual jobs", () => {
  it("creates a scored Job with the company and title I typed", () => {
    const db = openDb(":memory:");
    const r = addManualJob(db, { description: "We need React.", company: "Acme Ltda.", title: "Sr. Node.js Developer", workplace: "remote", location: "Remote" });
    expect(r).toMatchObject({ created: true, status: "scored" });
    expect(db.select().from(jobs).where(eq(jobs.id, r.jobId)).get()).toMatchObject({
      company: "Acme Ltda.", companyNorm: "acme", title: "Sr. Node.js Developer", titleNorm: "senior node developer", workplace: "remote",
    });
    expect(addManualJob(db, { description: "  We need React.  " })).toMatchObject({ jobId: r.jobId, created: false, existing: "same_text" });
  });

  it("leaves company/title for the tailoring when I don't type them", () => {
    const db = openDb(":memory:");
    const { jobId } = addManualJob(db, { description: "Some job" });
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()).toMatchObject({ companyNorm: "", titleNorm: "" });
  });

  it("attaches to a Job already collected with the same link, putting a filtered-out one back in the Queue", () => {
    const db = openDb(":memory:");
    ingest(db, [collected()], config.dedupe);
    const existing = db.select().from(jobs).get()!;
    db.update(jobs).set({ status: "filtered_out", prefilterReason: "hybrid outside Porto Alegre" }).where(eq(jobs.id, existing.id)).run();

    const r = addManualJob(db, { description: "My pasted text", url: "https://jobs.lever.co/acme/abc-123/apply" });
    expect(r).toMatchObject({ jobId: existing.id, created: false, existing: "same_link", status: "scored" });
    expect(db.select().from(jobs).all()).toHaveLength(1);
    expect(db.select().from(jobs).get()!.prefilterReason).toBeNull();
    expect(db.select().from(postings).where(eq(postings.jobId, existing.id)).all().map((p) => p.source).sort()).toEqual(["linkedin", "manual"]);
  });

  it("never pulls back a Job I already applied to", () => {
    const db = openDb(":memory:");
    ingest(db, [collected()], config.dedupe);
    const existing = db.select().from(jobs).get()!;
    db.update(jobs).set({ status: "applied" }).where(eq(jobs.id, existing.id)).run();
    expect(addManualJob(db, { description: "Again", url: "https://jobs.lever.co/acme/abc-123" })).toMatchObject({ status: "applied", existing: "same_link" });
  });

  it("refuses an empty description", () => {
    expect(() => addManualJob(openDb(":memory:"), { description: "   " })).toThrow(/empty/);
  });
});
