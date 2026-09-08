CREATE TABLE `paddle_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `paddle_events_received_at_idx` ON `paddle_events` (`received_at`);--> statement-breakpoint
ALTER TABLE `entitlements` ADD `last_event_at` integer;