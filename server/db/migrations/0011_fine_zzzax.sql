CREATE TABLE `instance_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `entitlements` ADD `earned_from_ref` text;--> statement-breakpoint
ALTER TABLE `entitlements` ADD `restore_period_end` integer;--> statement-breakpoint
CREATE INDEX `entitlements_user_id_idx` ON `entitlements` (`user_id`);--> statement-breakpoint
CREATE INDEX `users_referred_by_idx` ON `users` (`referred_by`);