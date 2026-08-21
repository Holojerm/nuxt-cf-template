ALTER TABLE `feedback` ADD `replied_at` integer;--> statement-breakpoint
ALTER TABLE `feedback` ADD `replied_by` text;--> statement-breakpoint
ALTER TABLE `users` ADD `signup_source` text;--> statement-breakpoint
ALTER TABLE `users` ADD `signup_medium` text;--> statement-breakpoint
ALTER TABLE `users` ADD `signup_campaign` text;--> statement-breakpoint
ALTER TABLE `users` ADD `signup_referrer` text;