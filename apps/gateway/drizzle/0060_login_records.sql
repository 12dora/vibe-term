CREATE TABLE `login_records` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`outcome` text NOT NULL,
	`uid` text,
	`username` text,
	`method` text,
	`second` text,
	`client` text NOT NULL,
	`kind` text NOT NULL,
	`via_node_id` text,
	`target_node_id` text,
	`ip` text,
	`user_agent` text,
	`origin` text,
	`code` text,
	CONSTRAINT "login_records_outcome_check" CHECK("login_records"."outcome" in ('success', 'failed')),
	CONSTRAINT "login_records_method_check" CHECK("login_records"."method" is null or "login_records"."method" in ('root', 'passkey')),
	CONSTRAINT "login_records_second_check" CHECK("login_records"."second" is null or "login_records"."second" in ('totp', 'passkey', 'waived', 'none')),
	CONSTRAINT "login_records_client_check" CHECK("login_records"."client" in ('web', 'cli', 'unknown')),
	CONSTRAINT "login_records_kind_check" CHECK("login_records"."kind" in ('interactive', 'background'))
);
--> statement-breakpoint
CREATE INDEX `login_records_outcome_at_idx` ON `login_records` (`outcome`,`at`);
