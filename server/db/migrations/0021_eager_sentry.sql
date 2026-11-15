CREATE TABLE `credential_challenges` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `credential_challenges_expires_at_idx` ON `credential_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `credential_passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`transports` text,
	`aaguid` text,
	`name` text NOT NULL,
	`prf_capable` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `credential_passkeys_user_id_idx` ON `credential_passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `credential_passwords` (
	`user_id` text PRIMARY KEY NOT NULL,
	`proof_hash` text NOT NULL,
	`salt` text NOT NULL,
	`iterations` integer NOT NULL,
	`kdf_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `credential_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`email` text NOT NULL,
	`mailbox` text NOT NULL,
	`token_hash` text NOT NULL,
	`payload` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_tokens_token_hash_unique` ON `credential_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `credential_tokens_mailbox_created_idx` ON `credential_tokens` (`mailbox`,`created_at`);--> statement-breakpoint
CREATE INDEX `credential_tokens_expires_at_idx` ON `credential_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `credential_tokens_used_at_idx` ON `credential_tokens` (`used_at`);