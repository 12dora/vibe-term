CREATE TABLE `hub_trust` (
	`hub_url` text PRIMARY KEY NOT NULL,
	`ca_pem` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL
);
