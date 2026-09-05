CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`device_id` text NOT NULL,
	`window_id` text NOT NULL,
	`window_name` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`end_reason` text,
	`password_hash` text NOT NULL,
	`origin` text NOT NULL,
	`url` text NOT NULL,
	`record_log` integer DEFAULT true NOT NULL,
	`log_bytes` integer DEFAULT 0 NOT NULL,
	`log_truncated` integer DEFAULT false NOT NULL,
	`log_seq` integer DEFAULT 0 NOT NULL,
	`log_purged_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`ended_at` integer,
	CONSTRAINT "shares_state_check" CHECK("shares"."state" in ('active', 'ended')),
	CONSTRAINT "shares_end_reason_check" CHECK("shares"."end_reason" is null or "shares"."end_reason" in ('revoked', 'expired', 'window_closed', 'device_removed'))
);
--> statement-breakpoint
CREATE INDEX `shares_state_idx` ON `shares` (`state`);--> statement-breakpoint
CREATE INDEX `shares_device_window_idx` ON `shares` (`device_id`,`window_id`);--> statement-breakpoint
CREATE TABLE `share_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`client_ip` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_access_tokens_token_hash_unique` ON `share_access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_access_tokens_share_idx` ON `share_access_tokens` (`share_id`);--> statement-breakpoint
CREATE TABLE `share_logs` (
	`share_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`pane_id` text NOT NULL,
	`cols` integer,
	`rows` integer,
	`data` blob NOT NULL,
	PRIMARY KEY(`share_id`, `seq`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "share_logs_kind_check" CHECK("share_logs"."kind" in ('out', 'in', 'resize', 'checkpoint'))
);
--> statement-breakpoint
CREATE TABLE `share_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`record_logs` integer DEFAULT true NOT NULL,
	`log_retention_days` integer DEFAULT 30 NOT NULL,
	`log_max_bytes` integer DEFAULT 52428800 NOT NULL,
	`default_origin` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "share_settings_singleton_check" CHECK("share_settings"."id" = 1)
);
