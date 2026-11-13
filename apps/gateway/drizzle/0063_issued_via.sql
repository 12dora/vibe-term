ALTER TABLE `access_tokens` ADD `issued_via` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `shares` ADD `issued_via` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_pane_grants` ADD `issued_via` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `port_maps` ADD `issued_via` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `port_maps` ADD `created_by_token_id` text;--> statement-breakpoint
ALTER TABLE `port_map_exports` ADD `issued_via` text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE `port_map_exports` ADD `created_by_token_id` text;
