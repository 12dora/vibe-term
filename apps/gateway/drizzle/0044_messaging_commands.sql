ALTER TABLE `telegram_bots` ADD `allow_commands` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `weixin_accounts` ADD `allow_commands` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_bot_chats` ADD `user_id` text;
