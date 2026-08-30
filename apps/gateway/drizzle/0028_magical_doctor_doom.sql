PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`node_id` text,
	`device_id` text,
	`pane_id` text,
	`provider_id` text,
	`model_id` text NOT NULL,
	`system_prompt` text,
	`write_mode` text DEFAULT 'confirm' NOT NULL,
	`use_provider_web_search` integer DEFAULT false NOT NULL,
	`provider_hosted_tools` text DEFAULT '[]' NOT NULL,
	`allow_control_chars` integer DEFAULT false NOT NULL,
	`origin_pane_title` text,
	`origin_process_name` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_error` text,
	`max_steps_per_turn` integer DEFAULT 25 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_sessions_write_mode_check" CHECK("write_mode" in ('confirm', 'auto')),
	CONSTRAINT "agent_sessions_status_check" CHECK("status" in ('idle', 'running', 'waiting_confirmation', 'stopped', 'error'))
);
--> statement-breakpoint
INSERT INTO `__new_agent_sessions`("id", "title", "node_id", "device_id", "pane_id", "provider_id", "model_id", "system_prompt", "write_mode", "use_provider_web_search", "provider_hosted_tools", "allow_control_chars", "origin_pane_title", "origin_process_name", "status", "last_error", "max_steps_per_turn", "created_at", "updated_at") SELECT "id", "title", "node_id", "device_id", "pane_id", "provider_id", "model_id", "system_prompt", "write_mode", "use_provider_web_search", "provider_hosted_tools", "allow_control_chars", "origin_pane_title", "origin_process_name", "status", "last_error", "max_steps_per_turn", "created_at", "updated_at" FROM `agent_sessions`;--> statement-breakpoint
DROP TABLE `agent_sessions`;--> statement-breakpoint
ALTER TABLE `__new_agent_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_sessions_node_id_idx` ON `agent_sessions` (`node_id`);