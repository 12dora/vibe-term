CREATE TABLE `hub_role_transitions` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`target_hub_id` text NOT NULL,
	`mode` text NOT NULL,
	`writer_epoch` integer,
	`phase` text NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "hub_role_transitions_mode_check" CHECK("mode" in ('active', 'standby')),
	CONSTRAINT "hub_role_transitions_phase_check" CHECK("phase" in ('accepted', 'persisting', 'restarting', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `hub_role_transitions_updated_at_idx` ON `hub_role_transitions` (`updated_at`);
