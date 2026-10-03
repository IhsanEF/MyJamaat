CREATE TABLE `ameer_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`jamaat_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	`previous_ameer_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ameer_decisions_jamaat_created` ON `ameer_decisions` (`jamaat_id`,`created_at`);
--> statement-breakpoint
-- Deterministic reconciliation: only an approved, same-Markaz person can receive the Ameer membership.
-- Ambiguous missing/cross-Markaz people and unproven permission grants require manual review.
INSERT INTO memberships (id,markaz_id,jamaat_id,person_id,role,permissions,created_at)
SELECT lower(hex(randomblob(16))),o.markaz_id,o.id,p.id,'ameer','{}',o.updated_at
FROM objects o
JOIN people p ON p.id = CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.ameerId') END AND p.markaz_id = o.markaz_id
WHERE o.kind = 'jamaat'
  AND CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.ameerStatus') END = 'approved'
  AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.jamaat_id = o.id AND m.person_id = p.id);
--> statement-breakpoint
UPDATE memberships SET role = 'member'
WHERE role = 'ameer' AND EXISTS (
  SELECT 1 FROM objects o WHERE o.id = memberships.jamaat_id AND o.markaz_id = memberships.markaz_id AND o.kind = 'jamaat'
  AND (COALESCE(CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.ameerStatus') END,'') <> 'approved'
    OR COALESCE(CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.ameerId') END,'') <> memberships.person_id)
);
--> statement-breakpoint
UPDATE memberships SET role = 'ameer'
WHERE EXISTS (
  SELECT 1 FROM objects o WHERE o.id = memberships.jamaat_id AND o.markaz_id = memberships.markaz_id AND o.kind = 'jamaat'
  AND CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.ameerStatus') END = 'approved'
  AND CASE WHEN json_valid(o.data) THEN json_extract(o.data,'$.ameerId') END = memberships.person_id
);
