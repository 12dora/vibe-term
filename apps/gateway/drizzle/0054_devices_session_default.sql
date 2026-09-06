PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`host` text,
	`port` integer DEFAULT 22,
	`username` text,
	`ssh_config_ref` text,
	`session` text DEFAULT 'vibeterm',
	`auth_mode` text NOT NULL,
	`password_enc` text,
	`private_key_enc` text,
	`private_key_passphrase_enc` text,
	`default_working_dir` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "devices_type_check" CHECK("type" in ('local', 'ssh')),
	CONSTRAINT "devices_auth_mode_check" CHECK("auth_mode" in ('password', 'key', 'agent', 'configRef', 'auto'))
);
--> statement-breakpoint
INSERT INTO `__new_devices`("id", "name", "type", "host", "port", "username", "ssh_config_ref", "session", "auth_mode", "password_enc", "private_key_enc", "private_key_passphrase_enc", "default_working_dir", "sort_order", "created_at", "updated_at") SELECT "id", "name", "type", "host", "port", "username", "ssh_config_ref", "session", "auth_mode", "password_enc", "private_key_enc", "private_key_passphrase_enc", "default_working_dir", "sort_order", "created_at", "updated_at" FROM `devices`;--> statement-breakpoint
DROP TABLE `devices`;--> statement-breakpoint
ALTER TABLE `__new_devices` RENAME TO `devices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
