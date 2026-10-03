CREATE TABLE `claim_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`invitation_id` text NOT NULL,
	`target_person_id` text NOT NULL,
	`source_person_id` text NOT NULL,
	`claimant_auth_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_claim_requests_invitation` ON `claim_requests` (`invitation_id`);--> statement-breakpoint
CREATE INDEX `idx_claim_requests_markaz_status` ON `claim_requests` (`markaz_id`,`status`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`person_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`mode` text NOT NULL,
	`required_email` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`claimed_at` text,
	`claimed_auth_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_invitations_token_hash` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_invitations_markaz_person` ON `invitations` (`markaz_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `person_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`person_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_person_corrections_person_created` ON `person_corrections` (`person_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `people` ADD `merged_into_id` text;