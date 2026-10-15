CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `action_batches` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`label` text NOT NULL,
	`actor` text NOT NULL,
	`undo` text NOT NULL,
	`createdAt` text NOT NULL,
	`undoneAt` text,
	`stepKey` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_batches_id_unique` ON `action_batches` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `action_batches_stepKey_unique` ON `action_batches` (`stepKey`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`importId` text NOT NULL,
	`accountId` text NOT NULL,
	`rowNumber` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`raw` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`importId`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_fingerprint` ON `import_rows` (`accountId`,`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_line` ON `import_rows` (`importId`,`rowNumber`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`fileName` text NOT NULL,
	`hash` text NOT NULL,
	`status` text NOT NULL,
	`preview` text NOT NULL,
	`createdAt` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`cancelRequested` integer DEFAULT 0 NOT NULL,
	`leaseUntil` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`jobId` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`handle` text NOT NULL,
	`relation` text DEFAULT '' NOT NULL,
	`isSelf` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_handle_unique` ON `people` (`handle`);--> statement-breakpoint
CREATE TABLE `repayments` (
	`id` text PRIMARY KEY NOT NULL,
	`personId` text NOT NULL,
	`date` text NOT NULL,
	`amountCents` integer NOT NULL,
	`direction` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`personId`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rule_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`ruleId` text,
	`title` text NOT NULL,
	`definition` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`baseVersion` integer,
	FOREIGN KEY (`ruleId`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`definition` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`importRowId` text NOT NULL,
	`date` text NOT NULL,
	`postDate` text,
	`description` text NOT NULL,
	`amountCents` integer NOT NULL,
	`kind` text NOT NULL,
	`bankCategory` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'inbox' NOT NULL,
	`proposal` text,
	`instruction` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`batchId` text,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`accountId`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`importRowId`) REFERENCES `import_rows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_importRowId_unique` ON `transactions` (`importRowId`);--> statement-breakpoint
CREATE INDEX `transaction_state` ON `transactions` (`state`);--> statement-breakpoint
CREATE INDEX `transaction_date` ON `transactions` (`date`);