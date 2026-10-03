-- Preserve historical duties exactly as recorded. Queue invalid rows for a leader
-- to review; current daily Mashwara planning revalidates membership and dates.
INSERT OR IGNORE INTO repair_reviews (id,markaz_id,kind,target_id,original,status,created_at)
SELECT 'legacy-assignment:' || a.id,a.markaz_id,'legacy-assignment',a.id,
  json_object('title',a.title,'status',a.status,'startAt',a.start_at,'data',a.data,'jamaatId',a.parent_id),
  'needs-review',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM objects a LEFT JOIN objects j ON j.id=a.parent_id AND j.markaz_id=a.markaz_id AND j.kind='jamaat'
WHERE a.kind='assignment' AND (
  j.id IS NULL OR NOT json_valid(a.data)
  OR NOT (CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.date') ELSE NULL END GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
  OR date(CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.date') ELSE NULL END,'+0 days') IS NOT (CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.date') ELSE NULL END)
  OR (CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.date') ELSE NULL END) < substr(j.start_at,1,10)
  OR (CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.date') ELSE NULL END) > substr(j.end_at,1,10)
  OR (CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.personId') ELSE NULL END) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.markaz_id=a.markaz_id AND m.jamaat_id=a.parent_id AND m.person_id=(CASE WHEN json_valid(a.data) THEN json_extract(a.data,'$.personId') ELSE NULL END))
);
