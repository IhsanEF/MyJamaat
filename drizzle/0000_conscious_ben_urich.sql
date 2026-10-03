CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`object_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_markaz_created` ON `audit` (`markaz_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `markaz` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`join_code` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_markaz_join_code` ON `markaz` (`join_code`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`jamaat_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`permissions` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_memberships_jamaat_person` ON `memberships` (`jamaat_id`,`person_id`);--> statement-breakpoint
CREATE INDEX `idx_memberships_person` ON `memberships` (`person_id`);--> statement-breakpoint
CREATE TABLE `objects` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`start_at` text,
	`end_at` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_objects_markaz_kind` ON `objects` (`markaz_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_objects_parent` ON `objects` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_objects_start` ON `objects` (`start_at`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`auth_id` text,
	`name` text NOT NULL,
	`phone` text,
	`email` text,
	`role` text DEFAULT 'worker' NOT NULL,
	`claimed_role` text DEFAULT 'worker' NOT NULL,
	`local_masjid_id` text,
	`local_markaz_id` text,
	`national_markaz_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_people_auth` ON `people` (`auth_id`);--> statement-breakpoint
CREATE INDEX `idx_people_markaz` ON `people` (`markaz_id`);