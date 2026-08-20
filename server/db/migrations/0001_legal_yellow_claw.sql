CREATE TABLE `entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`paddle_customer_id` text,
	`paddle_subscription_id` text NOT NULL,
	`product_key` text DEFAULT 'default' NOT NULL,
	`status` text NOT NULL,
	`current_period_end` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entitlements_paddle_subscription_id_unique` ON `entitlements` (`paddle_subscription_id`);