CREATE TABLE `agent_pane_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`from_node_id` text NOT NULL,
	`device_id` text NOT NULL,
	`pane_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_pane_grants_from_node_idx` ON `agent_pane_grants` (`from_node_id`);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `remote_grant` text;
