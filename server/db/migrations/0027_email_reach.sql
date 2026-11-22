CREATE TABLE `announcement_runs` (
	`announcement_id` text PRIMARY KEY NOT NULL,
	`stage` text DEFAULT 'users' NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`capped` integer DEFAULT 0 NOT NULL,
	`opted_out` integer DEFAULT 0 NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_subscribers_email_unique` ON `email_subscribers` (`email`);--> statement-breakpoint
CREATE INDEX `email_subscribers_confirmed_idx` ON `email_subscribers` (`confirmed_at`);--> statement-breakpoint
CREATE TABLE `subscriber_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`subscriber_id` text NOT NULL,
	`step_id` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriber_sends_subscriber_step_idx` ON `subscriber_sends` (`subscriber_id`,`step_id`);--> statement-breakpoint
CREATE INDEX `subscriber_sends_step_idx` ON `subscriber_sends` (`step_id`);