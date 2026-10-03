CREATE TABLE `mashwara_occurrences` (
	`series_id` text NOT NULL,
	`position` integer NOT NULL,
	`object_id` text NOT NULL,
	`original_start_at` text NOT NULL,
	`exception` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`series_id`, `position`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mashwara_occurrence_object` ON `mashwara_occurrences` (`object_id`);--> statement-breakpoint
CREATE TABLE `mashwara_series` (
	`id` text PRIMARY KEY NOT NULL,
	`markaz_id` text NOT NULL,
	`anchor_instant` text NOT NULL,
	`time_zone` text NOT NULL,
	`frequency` text NOT NULL,
	`end_count` integer,
	`end_day` text,
	`next_index` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`template_data` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mashwara_series_markaz` ON `mashwara_series` (`markaz_id`);--> statement-breakpoint
CREATE TABLE `mashwara_series_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`start_index` integer NOT NULL,
	`anchor_instant` text NOT NULL,
	`time_zone` text NOT NULL,
	`frequency` text NOT NULL,
	`title` text NOT NULL,
	`template_data` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mashwara_series_change_start` ON `mashwara_series_changes` (`series_id`,`start_index`);--> statement-breakpoint
CREATE TABLE `mashwara_series_collaborators` (
	`series_id` text NOT NULL,
	`person_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`series_id`, `person_id`)
);
--> statement-breakpoint
CREATE TABLE `mashwara_umoor_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`series_id` text NOT NULL,
	`start_index` integer NOT NULL,
	`end_index` integer,
	`title` text NOT NULL,
	`notes` text NOT NULL,
	`created_by` text NOT NULL,
	`version` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mashwara_umoor_template_series` ON `mashwara_umoor_templates` (`series_id`,`start_index`);
--> statement-breakpoint
INSERT INTO mashwara_series (id,markaz_id,anchor_instant,time_zone,frequency,end_count,end_day,next_index,title,template_data,created_by,updated_at,version)
SELECT ids.series_id,ids.markaz_id,
 (SELECT m.start_at FROM objects m WHERE m.markaz_id=ids.markaz_id AND m.kind='mashwara' AND json_valid(m.data) AND json_extract(m.data,'$.seriesId')=ids.series_id ORDER BY CAST(json_extract(m.data,'$.occurrence') AS INTEGER),m.start_at LIMIT 1),
 COALESCE((SELECT json_extract(m.data,'$.timeZone') FROM objects m WHERE m.markaz_id=ids.markaz_id AND m.kind='mashwara' AND json_valid(m.data) AND json_extract(m.data,'$.seriesId')=ids.series_id ORDER BY CAST(json_extract(m.data,'$.occurrence') AS INTEGER),m.start_at LIMIT 1),(SELECT time_zone FROM markaz WHERE id=ids.markaz_id),'America/Vancouver'),
 (SELECT json_extract(m.data,'$.recurrence') FROM objects m WHERE m.markaz_id=ids.markaz_id AND m.kind='mashwara' AND json_valid(m.data) AND json_extract(m.data,'$.seriesId')=ids.series_id ORDER BY CAST(json_extract(m.data,'$.occurrence') AS INTEGER),m.start_at LIMIT 1),
 NULL,NULL,
 (SELECT MAX(CAST(json_extract(m.data,'$.occurrence') AS INTEGER)) FROM objects m WHERE m.markaz_id=ids.markaz_id AND m.kind='mashwara' AND json_valid(m.data) AND json_extract(m.data,'$.seriesId')=ids.series_id),
 (SELECT m.title FROM objects m WHERE m.markaz_id=ids.markaz_id AND m.kind='mashwara' AND json_valid(m.data) AND json_extract(m.data,'$.seriesId')=ids.series_id ORDER BY CAST(json_extract(m.data,'$.occurrence') AS INTEGER),m.start_at LIMIT 1),
 (SELECT m.data FROM objects m WHERE m.markaz_id=ids.markaz_id AND m.kind='mashwara' AND json_valid(m.data) AND json_extract(m.data,'$.seriesId')=ids.series_id ORDER BY CAST(json_extract(m.data,'$.occurrence') AS INTEGER),m.start_at LIMIT 1),
 (SELECT m.created_by FROM objects m WHERE m.markaz_id=ids.markaz_id AND m.kind='mashwara' AND json_valid(m.data) AND json_extract(m.data,'$.seriesId')=ids.series_id ORDER BY CAST(json_extract(m.data,'$.occurrence') AS INTEGER),m.start_at LIMIT 1),
 datetime('now'),lower(hex(randomblob(16)))
FROM (SELECT markaz_id,json_extract(data,'$.seriesId') AS series_id FROM objects WHERE kind='mashwara' AND start_at IS NOT NULL AND json_valid(data) AND json_extract(data,'$.recurrence') IN ('weekly','monthly') AND json_extract(data,'$.seriesId') IS NOT NULL AND CAST(json_extract(data,'$.occurrence') AS INTEGER)>0 GROUP BY markaz_id,json_extract(data,'$.seriesId')) ids;
--> statement-breakpoint
INSERT OR IGNORE INTO mashwara_occurrences (series_id,position,object_id,original_start_at,exception)
SELECT json_extract(m.data,'$.seriesId'),CAST(json_extract(m.data,'$.occurrence') AS INTEGER)-1,m.id,m.start_at,1
FROM objects m JOIN mashwara_series s ON s.id=json_extract(m.data,'$.seriesId') AND s.markaz_id=m.markaz_id
WHERE m.kind='mashwara' AND m.start_at IS NOT NULL AND json_valid(m.data) AND CAST(json_extract(m.data,'$.occurrence') AS INTEGER)>0;
--> statement-breakpoint
INSERT INTO mashwara_series_changes (id,series_id,start_index,anchor_instant,time_zone,frequency,title,template_data,created_at)
SELECT id||':original',id,0,anchor_instant,time_zone,frequency,title,template_data,updated_at FROM mashwara_series;
--> statement-breakpoint
INSERT INTO mashwara_umoor_templates (id,series_id,start_index,end_index,title,notes,created_by,version)
SELECT u.id,o.series_id,o.position,NULL,u.title,COALESCE(json_extract(u.data,'$.notes'),''),u.created_by,lower(hex(randomblob(16)))
FROM objects u JOIN mashwara_occurrences o ON o.object_id=u.parent_id
WHERE u.kind='umoor' AND json_valid(u.data) AND json_extract(u.data,'$.recurring')=1
AND u.id=(SELECT u2.id FROM objects u2 JOIN mashwara_occurrences o2 ON o2.object_id=u2.parent_id WHERE u2.kind='umoor' AND json_valid(u2.data) AND json_extract(u2.data,'$.recurring')=1 AND o2.series_id=o.series_id AND u2.title=u.title ORDER BY o2.position,u2.created_at,u2.id LIMIT 1);
--> statement-breakpoint
UPDATE objects SET data=json_set(data,'$.templateId',(
 SELECT t.id FROM mashwara_umoor_templates t JOIN mashwara_occurrences o ON o.series_id=t.series_id
 WHERE o.object_id=objects.parent_id AND t.title=objects.title ORDER BY t.start_index DESC LIMIT 1
)) WHERE kind='umoor' AND json_valid(data) AND json_extract(data,'$.recurring')=1
AND EXISTS (SELECT 1 FROM mashwara_occurrences o JOIN mashwara_umoor_templates t ON t.series_id=o.series_id AND t.title=objects.title WHERE o.object_id=objects.parent_id);
