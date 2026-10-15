import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { JOB_STATUSES, SOURCES, WORKPLACES } from "../status.js";

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/**
 * Company: the employer behind Jobs and job boards (see GLOSSARY.md and ADR 0006). Identified by
 * normalized name; extra names (aliases, from Merge) live in company_names.
 */
export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Local Office of the company: `posting` (a Job of it is in my city) or `manual` (my correction, prevails). */
  localOffice: integer("local_office", { mode: "boolean" }).notNull().default(false),
  localOfficeSource: text("local_office_source", { enum: ["posting", "manual"] }),
  /** Followed companies have their boards collected (Greenhouse, Lever, Ashby). */
  followed: integer("followed", { mode: "boolean" }).notNull().default(false),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

/** Every normalized name a company is known by (its own and aliases). */
export const companyNames = sqliteTable("company_names", {
  nameNorm: text("name_norm").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
});

export const BOARD_ATS = ["greenhouse", "lever", "ashby"] as const;
export type BoardAts = (typeof BOARD_ATS)[number];

/** A company's public job board on an ATS (boards.greenhouse.io/<slug>, jobs.lever.co/<slug>, jobs.ashbyhq.com/<slug>). */
export const companyBoards = sqliteTable(
  "company_boards",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    ats: text("ats", { enum: BOARD_ATS }).notNull(),
    slug: text("slug").notNull(),
    /** `posting`: seen in a collected Posting's link; `import`: from `jobpipe companies import`. */
    discoveredFrom: text("discovered_from", { enum: ["posting", "import"] }).notNull(),
    /** Imported as a bare slug: the ATS was a guess, removed if the check finds no board. */
    guessed: integer("guessed", { mode: "boolean" }).notNull().default(false),
    discoveredAt: text("discovered_at").notNull(),
    checkStatus: text("check_status", { enum: ["unchecked", "ok", "not_found", "error"] }).notNull().default("unchecked"),
    checkError: text("check_error"),
    checkedAt: text("checked_at"),
    openJobs: integer("open_jobs"),
    /** Open jobs whose title passes my title filters. */
    devJobs: integer("dev_jobs"),
    /** Of those, remote or in Brazil/Latin America. */
    fitJobs: integer("fit_jobs"),
  },
  (t) => [uniqueIndex("company_boards_ats_slug_idx").on(t.ats, t.slug), index("company_boards_company_idx").on(t.companyId)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: JOB_STATUSES }).notNull(),
    company: text("company").notNull(),
    title: text("title").notNull(),
    companyNorm: text("company_norm").notNull(),
    titleNorm: text("title_norm").notNull(),
    companyId: text("company_id").references(() => companies.id),
    workplace: text("workplace", { enum: WORKPLACES }).notNull().default("unknown"),
    city: text("city"),
    officeDays: integer("office_days"),
    localOffice: integer("local_office", { mode: "boolean" }).notNull().default(false),
    localOfficeSource: text("local_office_source", { enum: ["posting", "inherited", "manual"] }),
    language: text("language", { enum: ["en", "pt", "es"] }),
    descriptionPostingId: text("description_posting_id"),
    applyUrl: text("apply_url"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    prefilterReason: text("prefilter_reason"),
    score: real("score"),
    scoreReason: text("score_reason"),
    matches: text("matches", { mode: "json" }).$type<string[]>(),
    gaps: text("gaps", { mode: "json" }).$type<string[]>(),
    analysisCandidateJobId: text("analysis_candidate_job_id"),
    guardErrors: text("guard_errors", { mode: "json" }).$type<string[]>(),
    pageWarning: integer("page_warning", { mode: "boolean" }).notNull().default(false),
    discardReason: text("discard_reason"),
    notes: text("notes"),
    appliedAt: text("applied_at"),
  },
  (t) => [
    check("jobs_status_check", sql`${t.status} in (${inList(JOB_STATUSES)})`),
    check("jobs_workplace_check", sql`${t.workplace} in (${inList(WORKPLACES)})`),
    index("jobs_status_idx").on(t.status),
    index("jobs_company_norm_idx").on(t.companyNorm),
  ],
);

export const postings = sqliteTable(
  "postings",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    source: text("source", { enum: SOURCES }).notNull(),
    externalId: text("external_id"),
    url: text("url"),
    applyUrl: text("apply_url"),
    /** Canonical form of apply_url (or url), used by the dedupe to recognize the same opening across sources. */
    urlKey: text("url_key"),
    company: text("company").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    workplace: text("workplace", { enum: WORKPLACES }).notNull().default("unknown"),
    /** Office days per week, when I typed them in the Add job form (collectors leave it null). */
    officeDays: integer("office_days"),
    salaryMin: real("salary_min"),
    salaryMax: real("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryInterval: text("salary_interval"),
    description: text("description").notNull(),
    postedAt: text("posted_at"),
    collectedAt: text("collected_at").notNull(),
  },
  (t) => [
    check("postings_source_check", sql`${t.source} in (${inList(SOURCES)})`),
    uniqueIndex("postings_source_external_idx").on(t.source, t.externalId),
    index("postings_job_idx").on(t.jobId),
    index("postings_url_key_idx").on(t.urlKey),
  ],
);

export const collectorState = sqliteTable("collector_state", {
  source: text("source").primaryKey(),
  lastSuccessAt: text("last_success_at"),
  blockedUntil: text("blocked_until"),
  /** Postings received in the last successful collection. */
  lastCount: integer("last_count"),
});

export type Company = typeof companies.$inferSelect;
export type CompanyBoard = typeof companyBoards.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Posting = typeof postings.$inferSelect;
export type NewPosting = typeof postings.$inferInsert;
