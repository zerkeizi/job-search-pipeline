CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`local_office` integer DEFAULT false NOT NULL,
	`local_office_source` text,
	`followed` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`ats` text NOT NULL,
	`slug` text NOT NULL,
	`discovered_from` text NOT NULL,
	`guessed` integer DEFAULT false NOT NULL,
	`discovered_at` text NOT NULL,
	`check_status` text DEFAULT 'unchecked' NOT NULL,
	`check_error` text,
	`checked_at` text,
	`open_jobs` integer,
	`dev_jobs` integer,
	`fit_jobs` integer,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_boards_ats_slug_idx` ON `company_boards` (`ats`,`slug`);--> statement-breakpoint
CREATE INDEX `company_boards_company_idx` ON `company_boards` (`company_id`);--> statement-breakpoint
CREATE TABLE `company_names` (
	`name_norm` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `company_id` text REFERENCES companies(id);