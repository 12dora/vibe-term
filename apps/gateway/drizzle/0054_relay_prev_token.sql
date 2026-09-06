ALTER TABLE `relay_tenants` ADD `prev_token_hash` text;--> statement-breakpoint
ALTER TABLE `relay_tenants` ADD `prev_token_issued_at` integer;--> statement-breakpoint
ALTER TABLE `mesh_relays` ADD `kicked_reason` text;
