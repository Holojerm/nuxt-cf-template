ALTER TABLE `magic_link_tokens` ADD `mailbox` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `magic_link_tokens_mailbox_created_idx` ON `magic_link_tokens` (`mailbox`,`created_at`);