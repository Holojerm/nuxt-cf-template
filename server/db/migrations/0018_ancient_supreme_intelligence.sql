CREATE TABLE `lifecycle_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`step_id` text NOT NULL,
	`subject_key` text DEFAULT '' NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lifecycle_sends_user_step_subject_idx` ON `lifecycle_sends` (`user_id`,`step_id`,`subject_key`);--> statement-breakpoint
CREATE INDEX `lifecycle_sends_step_idx` ON `lifecycle_sends` (`step_id`);