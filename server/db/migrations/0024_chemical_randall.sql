CREATE TABLE `pwa_idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`status` integer,
	`response` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pwa_idempotency_keys_user_key_idx` ON `pwa_idempotency_keys` (`user_id`,`key`);--> statement-breakpoint
CREATE INDEX `pwa_idempotency_keys_created_at_idx` ON `pwa_idempotency_keys` (`created_at`);