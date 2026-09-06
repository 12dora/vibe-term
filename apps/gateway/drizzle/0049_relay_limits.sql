ALTER TABLE `relay_config` ADD `max_tenants` integer;--> statement-breakpoint
ALTER TABLE `relay_config` ADD `total_bandwidth_bytes_per_sec` integer;--> statement-breakpoint
ALTER TABLE `relay_config` ADD `fair_share` integer DEFAULT 1 NOT NULL;
