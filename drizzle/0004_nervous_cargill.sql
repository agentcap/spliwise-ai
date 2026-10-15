CREATE TABLE `receipts` (
	`key` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`response` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`id` text PRIMARY KEY DEFAULT 'main' NOT NULL,
	`timezone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`consentAt` text
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `leaseToken` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `attempts` integer DEFAULT 0 NOT NULL;