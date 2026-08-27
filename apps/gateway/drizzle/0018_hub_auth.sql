CREATE TABLE `enrollment_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`enroll_public_key` blob NOT NULL,
	`authorization_json` text NOT NULL,
	`authorization_sig` blob NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`node_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollment_tokens_enroll_public_key_unique` ON `enrollment_tokens` (`enroll_public_key`);--> statement-breakpoint
CREATE TABLE `node_certs` (
	`node_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`admit_record_seq` integer NOT NULL,
	`certificate_bytes` blob NOT NULL,
	`cert_sig` blob NOT NULL,
	`authorization_bytes` blob NOT NULL,
	`authorization_sig` blob NOT NULL,
	`revoked_log_seq` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_certs_node_id_unique` ON `node_certs` (`node_id`);--> statement-breakpoint
CREATE TABLE `node_identity` (
	`id` integer PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`hub_url` text,
	`private_key` text NOT NULL,
	`x25519_private_key` text NOT NULL,
	`certificate_json` text NOT NULL,
	`cert_sig` blob NOT NULL,
	CONSTRAINT "node_identity_singleton_check" CHECK("node_identity"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `node_sessions` (
	`sid` blob PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`via_node_id` text NOT NULL,
	`sess_public_key` blob NOT NULL,
	`delegation_method` text NOT NULL,
	`credential_id` blob,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`hard_expires_at` integer NOT NULL,
	`renewed_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "node_sessions_delegation_method_check" CHECK("node_sessions"."delegation_method" in ('root', 'passkey'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_sessions_sid_unique` ON `node_sessions` (`sid`);--> statement-breakpoint
CREATE INDEX `node_sessions_user_id_via_node_id_idx` ON `node_sessions` (`user_id`,`via_node_id`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`last_seen_at` integer,
	`version` text,
	`direct_capable` integer DEFAULT false NOT NULL,
	`inventory_json` text DEFAULT '{}' NOT NULL,
	`inventory_version` integer DEFAULT 0 NOT NULL,
	`endpoints_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "nodes_status_check" CHECK("nodes"."status" in ('enrolled', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_id_unique` ON `nodes` (`id`);--> statement-breakpoint
CREATE TABLE `peer_cache` (
	`node_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`endpoints_json` text DEFAULT '[]' NOT NULL,
	`inventory_json` text DEFAULT '{}' NOT NULL,
	`direct_capable` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`list_version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peer_cache_node_id_unique` ON `peer_cache` (`node_id`);--> statement-breakpoint
CREATE TABLE `user_key_log` (
	`seq` integer NOT NULL,
	`user_id` text NOT NULL,
	`prev_hash` blob NOT NULL,
	`hash` blob NOT NULL,
	`root_epoch` integer NOT NULL,
	`type` text NOT NULL,
	`record_bytes` blob NOT NULL,
	`sig` blob NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `seq`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_key_log_type_check" CHECK("user_key_log"."type" in ('add-passkey', 'remove-passkey', 'rotate-root', 'set-totp', 'clear-totp', 'admit-node', 'revoke-node', 'reset-root'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_key_log_user_id_seq_unique` ON `user_key_log` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `user_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` blob NOT NULL,
	`public_key` blob NOT NULL,
	`rp_id` text NOT NULL,
	`origin` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`name` text,
	`log_seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_keys_credential_id_unique` ON `user_keys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`root_public_key` blob NOT NULL,
	`root_epoch` integer NOT NULL,
	`kdf_params_json` text NOT NULL,
	`totp_record_seq` integer,
	`key_log_head_seq` integer NOT NULL,
	`key_log_head_hash` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);