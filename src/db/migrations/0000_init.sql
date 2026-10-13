CREATE TABLE `collector_state` (
	`source` text PRIMARY KEY NOT NULL,
	`last_success_at` text,
	`blocked_until` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`company_norm` text NOT NULL,
	`title_norm` text NOT NULL,
	`workplace` text DEFAULT 'unknown' NOT NULL,
	`city` text,
	`office_days` integer,
	`local_office` integer DEFAULT false NOT NULL,
	`local_office_source` text,
	`language` text,
	`description_posting_id` text,
	`apply_url` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`prefilter_reason` text,
	`score` real,
	`score_reason` text,
	`matches` text,
	`gaps` text,
	`analysis_candidate_job_id` text,
	`guard_errors` text,
	`page_warning` integer DEFAULT false NOT NULL,
	`discard_reason` text,
	`notes` text,
	`applied_at` text,
	CONSTRAINT "jobs_status_check" CHECK("jobs"."status" in ('new', 'filtered_out', 'scored', 'analysis', 'generated', 'blocked', 'discarded', 'applied')),
	CONSTRAINT "jobs_workplace_check" CHECK("jobs"."workplace" in ('remote', 'hybrid', 'onsite', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_company_norm_idx` ON `jobs` (`company_norm`);--> statement-breakpoint
CREATE TABLE `postings` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`url` text,
	`apply_url` text,
	`company` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`workplace` text DEFAULT 'unknown' NOT NULL,
	`salary_min` real,
	`salary_max` real,
	`salary_currency` text,
	`salary_interval` text,
	`description` text NOT NULL,
	`posted_at` text,
	`collected_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "postings_source_check" CHECK("postings"."source" in ('linkedin', 'indeed', 'glassdoor', 'google', 'gupy', 'greenhouse', 'lever', 'ashby', 'remotive', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `postings_source_external_idx` ON `postings` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `postings_job_idx` ON `postings` (`job_id`);