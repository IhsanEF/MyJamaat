CREATE TABLE `baraka_operations` (
	`markaz_id` text NOT NULL,
	`jamaat_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`operation_kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`result_id` text NOT NULL,
	`original_id` text,
	`replacement_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`jamaat_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_baraka_operations_result` ON `baraka_operations` (`result_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_baraka_operations_original` ON `baraka_operations` (`original_id`);--> statement-breakpoint
CREATE INDEX `idx_baraka_operations_markaz` ON `baraka_operations` (`markaz_id`);--> statement-breakpoint
INSERT OR IGNORE INTO repair_reviews (id,markaz_id,kind,target_id,original,status,created_at)
SELECT 'baraka-invalid:' || id,markaz_id,'invalid-baraka',id,
  json_object('title',title,'data',data,'status',status,'createdAt',created_at),
  'needs-review',datetime('now')
FROM objects
WHERE kind='money' AND CASE
  WHEN json_valid(data)=0 THEN 1
  WHEN COALESCE(json_type(data,'$.amountCents'),'missing')<>'integer' THEN 1
  WHEN json_extract(data,'$.amountCents') NOT BETWEEN 1 AND 100000000 THEN 1
  WHEN COALESCE(json_extract(data,'$.type'),'missing') NOT IN ('collection','expense') THEN 1
  WHEN COALESCE(json_type(data,'$.date'),'missing')<>'text' THEN 1
  ELSE 0 END;
