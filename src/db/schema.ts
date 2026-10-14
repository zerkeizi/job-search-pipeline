import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { JOB_STATUSES, SOURCES, WORKPLACES } from "../status.js";

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: JOB_STATUSES }).notNull(),
    company: text("company").notNull(),
    title: text("title").notNull(),
    companyNorm: text("company_norm").notNull(),
    titleNorm: text("title_norm").notNull(),
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

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Posting = typeof postings.$inferSelect;
export type NewPosting = typeof postings.$inferInsert;
