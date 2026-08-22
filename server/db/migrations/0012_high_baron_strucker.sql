CREATE INDEX `magic_link_tokens_expires_at_idx` ON `magic_link_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `magic_link_tokens_used_at_idx` ON `magic_link_tokens` (`used_at`);--> statement-breakpoint
CREATE INDEX `mcp_connect_codes_expires_at_idx` ON `mcp_connect_codes` (`expires_at`);--> statement-breakpoint
CREATE INDEX `mcp_connect_codes_used_at_idx` ON `mcp_connect_codes` (`used_at`);