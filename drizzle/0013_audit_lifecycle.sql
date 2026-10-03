ALTER TABLE audit ADD COLUMN subject_id text;
--> statement-breakpoint
ALTER TABLE audit ADD COLUMN summary_json text NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE INDEX idx_audit_markaz_subject_created ON audit (markaz_id,subject_id,created_at);
--> statement-breakpoint
CREATE TABLE retention_policy (
  markaz_id text NOT NULL,
  category text NOT NULL,
  days integer NOT NULL CHECK (days BETWEEN 1 AND 36500),
  policy_reference text NOT NULL,
  updated_by text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (markaz_id,category)
);
