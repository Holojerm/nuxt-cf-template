CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_subject_idx` ON `user_identities` (`provider`,`subject`);--> statement-breakpoint
CREATE INDEX `user_identities_user_id_idx` ON `user_identities` (`user_id`);