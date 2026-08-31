CREATE TABLE `local_auth_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "local_auth_settings_singleton_check" CHECK("local_auth_settings"."id" = 'default')
);
