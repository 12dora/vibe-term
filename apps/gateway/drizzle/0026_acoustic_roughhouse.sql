ALTER TABLE `agent_sessions` ADD `node_id` text;--> statement-breakpoint
CREATE INDEX `agent_sessions_node_id_idx` ON `agent_sessions` (`node_id`);