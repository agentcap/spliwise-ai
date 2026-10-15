CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`transactionId` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`data` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`transactionId`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachment_transaction` ON `attachments` (`transactionId`);--> statement-breakpoint
CREATE TABLE `merchant_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_aliases_pattern_unique` ON `merchant_aliases` (`pattern`);--> statement-breakpoint
CREATE TABLE `split_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`category` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`destination` text DEFAULT '' NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`participants` text NOT NULL,
	`split` text NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `tripId` text REFERENCES trips(id);--> statement-breakpoint
ALTER TABLE `transactions` ADD `source` text DEFAULT 'import' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `onboardingDismissed` integer DEFAULT 0 NOT NULL;
