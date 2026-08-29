CREATE TABLE `device_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `device_folders_parent_id_idx` ON `device_folders` (`parent_id`);--> statement-breakpoint
CREATE TABLE `device_folder_placements` (
	`item_key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`node_id` text NOT NULL,
	`device_id` text,
	`folder_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `device_folders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_folder_placements_kind_check" CHECK("device_folder_placements"."kind" in ('node', 'device'))
);
--> statement-breakpoint
CREATE INDEX `device_folder_placements_folder_id_idx` ON `device_folder_placements` (`folder_id`);
