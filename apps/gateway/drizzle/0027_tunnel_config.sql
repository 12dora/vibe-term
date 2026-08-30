CREATE TABLE `tunnel_config` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'off' NOT NULL,
	`hostname` text,
	`tunnel_name` text,
	`tunnel_id` text,
	`auto_start` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "tunnel_config_singleton_check" CHECK("tunnel_config"."id" = 'default'),
	CONSTRAINT "tunnel_config_mode_check" CHECK("tunnel_config"."mode" in ('off', 'quick', 'named'))
);
