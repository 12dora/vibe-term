PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`search_provider` text DEFAULT 'none' NOT NULL,
	`tavily_api_key_enc` text,
	`brave_api_key_enc` text,
	`default_provider_id` text,
	`default_model_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`default_provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_settings_singleton_check" CHECK("id" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_agent_settings`("id", "search_provider", "tavily_api_key_enc", "brave_api_key_enc", "default_provider_id", "default_model_id", "updated_at") SELECT "id", "search_provider", "tavily_api_key_enc", "brave_api_key_enc", "default_provider_id", "default_model_id", "updated_at" FROM `agent_settings`;--> statement-breakpoint
DROP TABLE `agent_settings`;--> statement-breakpoint
ALTER TABLE `__new_agent_settings` RENAME TO `agent_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;