ALTER TABLE `postings` ADD `url_key` text;--> statement-breakpoint
CREATE INDEX `postings_url_key_idx` ON `postings` (`url_key`);