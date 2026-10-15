ALTER TABLE `jobs` ADD `activity` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `response` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `transactionIds` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `notes` text DEFAULT '[]' NOT NULL;