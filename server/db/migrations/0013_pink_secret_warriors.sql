CREATE TABLE `ops_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`path` text,
	`notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ops_events_notified_at_idx` ON `ops_events` (`notified_at`);