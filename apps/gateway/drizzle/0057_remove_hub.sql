DROP TABLE IF EXISTS hub_role_transitions;
--> statement-breakpoint
DROP TABLE IF EXISTS user_hub_authorizations;
--> statement-breakpoint
DROP TABLE IF EXISTS mesh_hubs;
--> statement-breakpoint
DROP TABLE IF EXISTS hub_trust;
--> statement-breakpoint
DROP TABLE IF EXISTS enrollment_token_repl;
--> statement-breakpoint
DROP TABLE IF EXISTS enrollment_token_repl_meta;
--> statement-breakpoint
DELETE FROM peer_cache WHERE node_id = 'hub';
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_node_identity` (
	`id` integer PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`private_key` text NOT NULL,
	`x25519_private_key` text NOT NULL,
	`certificate_json` text NOT NULL,
	`cert_sig` blob NOT NULL,
	`user_id` text,
	`uplink_kind` text DEFAULT 'none' NOT NULL,
	`name` text,
	CONSTRAINT "node_identity_singleton_check" CHECK("id" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_node_identity`("id", "node_id", "private_key", "x25519_private_key", "certificate_json", "cert_sig", "user_id", "uplink_kind", "name") SELECT "id", "node_id", "private_key", "x25519_private_key", "certificate_json", "cert_sig", "user_id", CASE WHEN "uplink_kind" = 'relay' THEN 'relay' ELSE 'none' END, "name" FROM `node_identity`;--> statement-breakpoint
DROP TABLE `node_identity`;--> statement-breakpoint
ALTER TABLE `__new_node_identity` RENAME TO `node_identity`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
