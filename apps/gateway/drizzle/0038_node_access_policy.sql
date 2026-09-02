CREATE TABLE `node_access_policy` (
	`id` integer PRIMARY KEY NOT NULL,
	`allow_domain_access` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "node_access_policy_singleton_check" CHECK("node_access_policy"."id" = 1)
);
