CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`kind` text DEFAULT 'idea' NOT NULL,
	`message` text NOT NULL,
	`rating` integer,
	`email` text,
	`path` text,
	`replay_url` text,
	`posthog_distinct_id` text,
	`ip_hash` text,
	`user_agent` text,
	`status` text DEFAULT 'new' NOT NULL,
	`issue_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feedback_status_created_idx` ON `feedback` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_ip_hash_created_idx` ON `feedback` (`ip_hash`,`created_at`);