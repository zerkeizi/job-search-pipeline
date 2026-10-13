import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { jobs, postings } from "../src/db/schema.js";
import { canonicalUrl, descriptionSimilarity, titlesSimilar } from "../src/dedupe.js";
import { ingest, type PostingIn } from "../src/ingest.js";

const dedupe = loadConfig().dedupe;
const LOREM =
  "You will design and build web applications with React and Node, own features end to end, write tests, " +
  "review code, collaborate with product and design, improve performance and accessibility, and mentor peers. " +
  "We value clear communication, pragmatic engineering and a strong sense of ownership over the product.";

function posting(over: Partial<PostingIn> = {}): PostingIn {
  const externalId = over.externalId ?? "1";
  return {
    source: "linkedin", externalId, url: `https://linkedin.example/${externalId}`, applyUrl: null,
    company: "Acme Tecnologia Ltda.", title: "Senior Full-stack Developer", location: "Porto Alegre",
    workplace: "unknown", salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null,
    description: LOREM, postedAt: null, ...over,
  };
}

const gupyToken = (jobId: number, source: string) => Buffer.from(JSON.stringify({ jobId, source })).toString("base64");

describe("canonicalUrl", () => {
  it("unifies Greenhouse variants", () => {
    const key = "greenhouse/acme/123";
    expect(canonicalUrl("https://boards.greenhouse.io/acme/jobs/123?gh_src=linkedin")).toBe(key);
    expect(canonicalUrl("https://job-boards.greenhouse.io/acme/jobs/123")).toBe(key);
    expect(canonicalUrl("https://boards-api.greenhouse.io/v1/boards/acme/jobs/123")).toBe(key);
  });

  it("drops Lever/Ashby apply suffixes and decodes Gupy tokens", () => {
    expect(canonicalUrl("https://jobs.lever.co/acme/abc-123/apply")).toBe("lever/acme/abc-123");
    expect(canonicalUrl("https://jobs.ashbyhq.com/Acme/abc/application")).toBe("ashby/acme/abc");
    const a = `https://acme.gupy.io/job/${gupyToken(42, "gupy_portal")}?jobBoardSource=gupy_portal`;
    const b = `https://acme.gupy.io/job/${gupyToken(42, "linkedin")}`;
    expect(canonicalUrl(a)).toBe("gupy/42");
    expect(canonicalUrl(b)).toBe("gupy/42");
  });

  it("strips tracking from other URLs", () => {
    expect(canonicalUrl("https://www.acme.com/careers/dev/?utm_source=x#top")).toBe("acme.com/careers/dev");
    expect(canonicalUrl("not a url")).toBeNull();
  });
});

describe("similarity", () => {
  it("treats added seniority words as the same title", () => {
    expect(titlesSimilar("backend engineer", "senior backend engineer")).toBe(true);
    expect(titlesSimilar("backend engineer", "data analyst")).toBe(false);
  });

  it("scores identical descriptions 1 and unrelated ones near 0", () => {
    expect(descriptionSimilarity(LOREM, LOREM)).toBe(1);
    expect(descriptionSimilarity(LOREM, "Completely different text about accounting and taxes in Brazil today")).toBe(0);
  });
});

describe("ingest dedupe", () => {
  const now = new Date("2026-10-13T12:00:00Z");

  it("links the same opening found on another board through the apply URL, preferring the ATS", () => {
    const db = openDb(":memory:");
    ingest(db, [posting({ applyUrl: "https://boards.greenhouse.io/acme/jobs/9?gh_src=li" })], dedupe, now);
    const r = ingest(
      db,
      [posting({ source: "greenhouse", externalId: "9", url: "https://job-boards.greenhouse.io/acme/jobs/9", applyUrl: "https://job-boards.greenhouse.io/acme/jobs/9", title: "Something renamed", description: "Different text entirely" })],
      dedupe,
      now,
    );
    expect(r).toMatchObject({ created: 0, linked: 1 });
    const [job] = db.select().from(jobs).all();
    const described = db.select().from(postings).where(eq(postings.id, job!.descriptionPostingId!)).get();
    expect(described?.source).toBe("greenhouse");
    expect(job?.applyUrl).toBe("https://job-boards.greenhouse.io/acme/jobs/9");
  });

  it("links a repost (same company, similar title, near-identical description) without touching the status", () => {
    const db = openDb(":memory:");
    ingest(db, [posting()], dedupe, now);
    db.update(jobs).set({ status: "applied" }).run();
    const r = ingest(db, [posting({ externalId: "2", title: "Full-stack Developer (Remote)", description: LOREM + " Apply now." })], dedupe, now);
    expect(r).toMatchObject({ created: 0, linked: 1 });
    expect(db.select().from(jobs).all().map((j) => j.status)).toEqual(["applied"]);
  });

  it("flags a moderately similar posting at the same company as a possible duplicate", () => {
    const db = openDb(":memory:");
    ingest(db, [posting()], dedupe, now);
    const half = LOREM.split(". ").slice(0, 2).join(". ") + ". Totally new paragraph describing a payments platform, Kotlin services and on-call duties for the team.";
    const r = ingest(db, [posting({ externalId: "3", description: half })], dedupe, now);
    const sim = descriptionSimilarity(LOREM, half);
    expect(sim).toBeGreaterThanOrEqual(dedupe.similar_threshold);
    expect(sim).toBeLessThan(dedupe.same_threshold);
    expect(r).toMatchObject({ created: 1, flagged: 1 });
    const flagged = db.select().from(jobs).all().find((j) => j.analysisCandidateJobId);
    expect(flagged?.analysisCandidateJobId).toBeTruthy();
  });

  it("keeps different openings at the same company separate", () => {
    const db = openDb(":memory:");
    ingest(db, [posting()], dedupe, now);
    const r = ingest(db, [posting({ externalId: "4", title: "Data Analyst", description: "Analyse sales data in SQL and build dashboards for finance." })], dedupe, now);
    expect(r).toMatchObject({ created: 1, flagged: 0 });
  });

  it("treats a repost after the window as a new job", () => {
    const db = openDb(":memory:");
    ingest(db, [posting()], dedupe, now);
    const later = new Date(now.getTime() + (dedupe.window_days + 1) * 86_400_000);
    expect(ingest(db, [posting({ externalId: "5" })], dedupe, later)).toMatchObject({ created: 1, linked: 0 });
  });
});
