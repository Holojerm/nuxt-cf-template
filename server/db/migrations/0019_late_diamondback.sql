CREATE TABLE `social_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`not_before` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`remote_id` text,
	`error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `social_posts_service_kind_ref_idx` ON `social_posts` (`service`,`kind`,`ref`);--> statement-breakpoint
CREATE INDEX `social_posts_status_not_before_idx` ON `social_posts` (`status`,`not_before`);