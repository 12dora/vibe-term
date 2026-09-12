CREATE TABLE `node_local_prefs` (
	`node_id` text PRIMARY KEY NOT NULL,
	`paused` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
