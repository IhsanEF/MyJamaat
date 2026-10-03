CREATE TABLE `recorded_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`object_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recorded_revisions_object` ON `recorded_revisions` (`object_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_recorded_revisions_markaz` ON `recorded_revisions` (`markaz_id`);