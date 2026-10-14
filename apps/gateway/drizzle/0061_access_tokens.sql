CREATE TABLE `access_token_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` text NOT NULL,
	`user_id` text NOT NULL,
	`event` text NOT NULL,
	`ip` text,
	`at` integer NOT NULL,
	CONSTRAINT "access_token_events_event_check" CHECK("access_token_events"."event" in ('created', 'revoked', 'used'))
);
--> statement-breakpoint
CREATE INDEX `access_token_events_token_id_idx` ON `access_token_events` (`token_id`);--> statement-breakpoint
CREATE TABLE `access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`scopes` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`last_used_ip` text,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_secret_hash_unique` ON `access_tokens` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `access_tokens_user_id_idx` ON `access_tokens` (`user_id`);
