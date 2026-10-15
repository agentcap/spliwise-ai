CREATE TABLE `assistant_events` (
	`id` text PRIMARY KEY NOT NULL,
	`jobId` text NOT NULL,
	`kind` text NOT NULL,
	`targetId` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`batchId` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`batchId`) REFERENCES `action_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_event_job` ON `assistant_events` (`jobId`);--> statement-breakpoint
CREATE TABLE `assistant_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`jobId` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdAt` text NOT NULL,
	`batchId` text
);
--> statement-breakpoint
CREATE INDEX `assistant_request_status` ON `assistant_requests` (`status`);--> statement-breakpoint
CREATE TABLE `user_context` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`quote` text NOT NULL,
	`personId` text,
	`tripId` text,
	`from` text,
	`to` text,
	`version` integer DEFAULT 1 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`personId`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tripId`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action
);
