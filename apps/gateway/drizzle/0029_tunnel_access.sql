ALTER TABLE `tunnel_config` ADD `externally_managed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tunnel_config` ADD `exposure_acknowledged_at` text;--> statement-breakpoint
CREATE TABLE `tunnel_access` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`api_token_enc` text,
	`team_domain` text,
	`app_id` text,
	`aud` text,
	`hostname` text,
	`rules_json` text DEFAULT '[]' NOT NULL,
	`enforce_jwt` integer DEFAULT false NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "tunnel_access_singleton_check" CHECK("tunnel_access"."id" = 'default')
);
