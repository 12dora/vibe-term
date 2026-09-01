CREATE TABLE `mesh_hubs` (
	`hub_node_id` text PRIMARY KEY NOT NULL,
	`public_url` text NOT NULL,
	`name` text,
	`mode` text NOT NULL,
	`priority` integer NOT NULL,
	`writer_epoch` integer NOT NULL,
	`ca_fingerprint` text,
	`online` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`updated_at` integer NOT NULL
);
