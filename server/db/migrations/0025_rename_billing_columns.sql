-- destructive-ok: billing moved from Paddle to Stripe; the columns and the events table take provider-neutral names in place. Rows are kept.
ALTER TABLE `entitlements` RENAME COLUMN `paddle_subscription_id` TO `billing_ref`;--> statement-breakpoint
ALTER TABLE `entitlements` RENAME COLUMN `paddle_customer_id` TO `provider_customer_id`;--> statement-breakpoint
DROP INDEX `entitlements_paddle_subscription_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `entitlements_billing_ref_unique` ON `entitlements` (`billing_ref`);--> statement-breakpoint
ALTER TABLE `paddle_events` RENAME TO `billing_events`;--> statement-breakpoint
DROP INDEX `paddle_events_received_at_idx`;--> statement-breakpoint
CREATE INDEX `billing_events_received_at_idx` ON `billing_events` (`received_at`);
