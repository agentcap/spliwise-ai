CREATE TABLE `data_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`fileName` text NOT NULL,
	`payload` text NOT NULL,
	`preview` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`createdAt` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL
);
