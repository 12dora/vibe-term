CREATE TABLE `port_maps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`listen_host` text DEFAULT '127.0.0.1' NOT NULL,
	`listen_port` integer NOT NULL,
	`target_node_id` text NOT NULL,
	`target_host` text DEFAULT '127.0.0.1' NOT NULL,
	`target_port` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `port_maps_listen_idx` ON `port_maps` (`listen_host`,`listen_port`);--> statement-breakpoint
CREATE TABLE `port_map_exports` (
	`map_id` text PRIMARY KEY NOT NULL,
	`from_node_id` text NOT NULL,
	`host` text DEFAULT '127.0.0.1' NOT NULL,
	`port` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
