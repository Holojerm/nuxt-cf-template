DROP INDEX `ops_events_notified_at_idx`;--> statement-breakpoint
ALTER TABLE `ops_events` DROP COLUMN `notified_at`;