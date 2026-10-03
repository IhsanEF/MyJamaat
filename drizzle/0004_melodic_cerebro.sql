ALTER TABLE `markaz` ADD `time_zone` text DEFAULT 'America/Vancouver' NOT NULL;
--> statement-breakpoint
-- Keep old values unchanged. Flag dates that cannot be interpreted as civil days,
-- and non-daily Mashwaras that lack a clock time, for leader review.
INSERT OR IGNORE INTO repair_reviews (id,markaz_id,kind,target_id,original,status,created_at)
SELECT 'schedule-date:' || o.id,o.markaz_id,'schedule-date',o.id,
  json_object('kind',o.kind,'startAt',o.start_at,'endAt',o.end_at,'data',o.data),
  'needs-review',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM objects o
WHERE o.kind IN ('jamaat','stay','mashwara','event') AND (
  (o.start_at IS NOT NULL AND (date(substr(o.start_at,1,10),'+0 days') IS NOT substr(o.start_at,1,10) OR (length(o.start_at) > 10 AND datetime(o.start_at) IS NULL)))
  OR (o.end_at IS NOT NULL AND (date(substr(o.end_at,1,10),'+0 days') IS NOT substr(o.end_at,1,10) OR (length(o.end_at) > 10 AND datetime(o.end_at) IS NULL)))
  OR (o.kind = 'mashwara' AND length(o.start_at) = 10 AND (CASE WHEN json_valid(o.data) THEN COALESCE(json_extract(o.data,'$.daily'),0) ELSE 0 END) <> 1)
  OR (o.start_at IS NOT NULL AND o.end_at IS NOT NULL AND (julianday(o.end_at) < julianday(o.start_at) OR (length(o.start_at) = 10) <> (length(o.end_at) = 10)))
);
