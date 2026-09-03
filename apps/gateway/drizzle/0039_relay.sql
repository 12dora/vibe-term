CREATE TABLE `relay_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text,
	`password_epoch` integer DEFAULT 0 NOT NULL,
	`min_token_epoch` integer DEFAULT 0 NOT NULL,
	`admin_token_hash` text,
	`default_quota_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "relay_config_singleton_check" CHECK("relay_config"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `relay_tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`root_public_key` blob NOT NULL,
	`root_epoch` integer NOT NULL,
	`token_hash` text NOT NULL,
	`token_epoch` integer NOT NULL,
	`quota_json` text,
	`label` text,
	`kicked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`bytes_in` integer DEFAULT 0 NOT NULL,
	`bytes_out` integer DEFAULT 0 NOT NULL,
	`key_log_head_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_tenants_root_public_key_unique` ON `relay_tenants` (`root_public_key`);
--> statement-breakpoint
CREATE TABLE `relay_nodes` (
	`tenant_id` text NOT NULL,
	`node_id` text NOT NULL,
	`ed_pk` blob NOT NULL,
	`x25519_pk` blob NOT NULL,
	`status` text NOT NULL,
	`admit_seq` integer,
	`last_seen_at` integer,
	`proto_version` integer,
	`client_version` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `node_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `relay_tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "relay_nodes_status_check" CHECK("status" in ('pending', 'admitted', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE `relay_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`enroll_pk` blob NOT NULL,
	`authorization_bytes` blob NOT NULL,
	`authorization_sig` blob NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`node_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `relay_tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_enrollments_enroll_pk_unique` ON `relay_enrollments` (`enroll_pk`);
--> statement-breakpoint
CREATE TABLE `relay_key_log` (
	`tenant_id` text NOT NULL,
	`seq` integer NOT NULL,
	`blob` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `seq`),
	FOREIGN KEY (`tenant_id`) REFERENCES `relay_tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
