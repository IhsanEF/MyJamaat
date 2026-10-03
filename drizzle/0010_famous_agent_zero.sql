CREATE TABLE `directory_candidates` (
	`osm_id` text PRIMARY KEY NOT NULL,
	`data_json` text NOT NULL,
	`state` text NOT NULL,
	`checked_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_directory_candidates_expires` ON `directory_candidates` (`expires_at`);