PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_key_log` (
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
	CONSTRAINT "user_key_log_type_check" CHECK("type" in ('add-passkey', 'remove-passkey', 'rotate-root', 'set-totp', 'clear-totp', 'admit-node', 'revoke-node', 'reset-root', 'admit-hub', 'retire-hub', 'rotate-root-keep', 'set-relays', 'meta-key', 'rename-node', 'readmit-node'))
);
--> statement-breakpoint
INSERT INTO `__new_user_key_log`("seq", "user_id", "prev_hash", "hash", "root_epoch", "type", "record_bytes", "sig", "payload_json", "created_at") SELECT "seq", "user_id", "prev_hash", "hash", "root_epoch", "type", "record_bytes", "sig", "payload_json", "created_at" FROM `user_key_log`;--> statement-breakpoint
DROP TABLE `user_key_log`;--> statement-breakpoint
ALTER TABLE `__new_user_key_log` RENAME TO `user_key_log`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_key_log_user_id_seq_unique` ON `user_key_log` (`user_id`,`seq`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
