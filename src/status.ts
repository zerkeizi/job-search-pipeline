/** Job statuses (see GLOSSARY.md and CLAUDE.md). Stored as text, constrained by a CHECK. */
export const JOB_STATUSES = [
  "new",
  "filtered_out",
  "scored",
  "analysis",
  "generated",
  "blocked",
  "discarded",
  "applied",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const SOURCES = [
  "linkedin",
  "indeed",
  "glassdoor",
  "google",
  "gupy",
  "greenhouse",
  "lever",
  "ashby",
  "remotive",
  "manual",
] as const;

export type Source = (typeof SOURCES)[number];

export const WORKPLACES = ["remote", "hybrid", "onsite", "unknown"] as const;

export type Workplace = (typeof WORKPLACES)[number];
