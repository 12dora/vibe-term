ALTER TABLE `site_settings` ADD `enable_notification_push` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `enable_bell_push` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `enable_bell_sound` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` DROP COLUMN `enable_browser_bell_toast`;--> statement-breakpoint
ALTER TABLE `site_settings` DROP COLUMN `enable_telegram_bell_push`;--> statement-breakpoint
ALTER TABLE `site_settings` DROP COLUMN `enable_telegram_notification_push`;--> statement-breakpoint
ALTER TABLE `site_settings` DROP COLUMN `enable_weixin_bell_push`;--> statement-breakpoint
ALTER TABLE `site_settings` DROP COLUMN `enable_weixin_notification_push`;