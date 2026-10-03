CREATE TABLE `repair_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`original` text NOT NULL,
	`status` text DEFAULT 'needs-review' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_repair_reviews_markaz_status` ON `repair_reviews` (`markaz_id`,`status`);
--> statement-breakpoint
-- Preserve ambiguous grants for review before removing their live authority.
INSERT INTO repair_reviews (id,markaz_id,kind,target_id,original,status,created_at)
SELECT 'legacy-grant:' || id,markaz_id,'legacy-grant',id,permissions,'needs-review',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM memberships
WHERE json_valid(permissions)
  AND (COALESCE(json_extract(permissions,'$.manage'),0) = 1 OR COALESCE(json_extract(permissions,'$.viewContacts'),0) = 1)
  AND NOT (COALESCE(json_extract(permissions,'$.grant.by'),'') <> '' AND json_extract(permissions,'$.grant.authority') IN ('markaz-leader','approved-ameer'));
--> statement-breakpoint
UPDATE memberships SET permissions = json_set(permissions,'$.manage',json('false'),'$.viewContacts',json('false'),'$.review','legacy-grant-needs-review')
WHERE id IN (SELECT target_id FROM repair_reviews WHERE kind = 'legacy-grant');
--> statement-breakpoint
-- Keep the original assignment JSON in the review table; remove only the unsafe live assignee.
INSERT INTO repair_reviews (id,markaz_id,kind,target_id,original,status,created_at)
SELECT 'invalid-assignment:' || o.id,o.markaz_id,'invalid-assignment',o.id,o.data,'needs-review',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM objects o
WHERE o.kind = 'assignment' AND json_valid(o.data) AND json_type(o.data,'$.personId') = 'text'
  AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.jamaat_id = o.parent_id AND m.person_id = json_extract(o.data,'$.personId') AND m.markaz_id = o.markaz_id);
--> statement-breakpoint
UPDATE objects SET data = json_set(data,'$.personId',NULL,'$.needsAssignmentReview',json('true')),status = 'unassigned',updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN (SELECT target_id FROM repair_reviews WHERE kind = 'invalid-assignment');
--> statement-breakpoint
-- Invalid daily plan participants are removed from the live array, with the original plan retained.
INSERT INTO repair_reviews (id,markaz_id,kind,target_id,original,status,created_at)
SELECT 'invalid-daily-plan:' || o.id,o.markaz_id,'invalid-daily-plan',o.id,o.data,'needs-review',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM objects o
JOIN objects d ON d.id = o.parent_id AND d.kind = 'mashwara' AND json_extract(d.data,'$.daily') = 1
WHERE o.kind = 'umoor' AND json_valid(o.data) AND json_type(o.data,'$.personIds') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(o.data,'$.personIds') p WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.jamaat_id = d.parent_id AND m.person_id = p.value AND m.markaz_id = o.markaz_id));
--> statement-breakpoint
UPDATE objects SET data = json_set(data,'$.personIds',json(COALESCE((
  SELECT json_group_array(p.value) FROM json_each(objects.data,'$.personIds') p
  JOIN objects d ON d.id = objects.parent_id AND d.kind = 'mashwara'
  JOIN memberships m ON m.jamaat_id = d.parent_id AND m.person_id = p.value AND m.markaz_id = objects.markaz_id
),'[]')),'$.needsAssignmentReview',json('true')),updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN (SELECT target_id FROM repair_reviews WHERE kind = 'invalid-daily-plan');
--> statement-breakpoint
INSERT INTO repair_reviews (id,markaz_id,kind,target_id,original,status,created_at)
SELECT 'invalid-daily-ameer:' || d.id,d.markaz_id,'invalid-daily-ameer',d.id,d.data,'needs-review',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM objects d
WHERE d.kind = 'mashwara' AND json_valid(d.data) AND json_extract(d.data,'$.daily') = 1 AND json_type(d.data,'$.ameerId') = 'text'
  AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.jamaat_id = d.parent_id AND m.person_id = json_extract(d.data,'$.ameerId') AND m.markaz_id = d.markaz_id);
--> statement-breakpoint
UPDATE objects SET data = json_set(data,'$.ameerId',NULL,'$.needsAssignmentReview',json('true')),updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN (SELECT target_id FROM repair_reviews WHERE kind = 'invalid-daily-ameer');
