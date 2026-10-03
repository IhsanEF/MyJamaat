-- Applied only to a disposable synthetic fixture before the Task 09 migration.
INSERT INTO objects (id,markaz_id,kind,title,start_at,end_at,status,data,created_by,created_at,updated_at)
VALUES ('legacy-invalid-trip','markaz-surrey','jamaat','Synthetic invalid historical trip','2026-02-30','2026-03-02','planning','{}','p-admin','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z');
INSERT INTO objects (id,markaz_id,kind,title,start_at,status,data,created_by,created_at,updated_at)
VALUES ('legacy-untimed-meeting','markaz-surrey','mashwara','Synthetic meeting missing clock time','2026-10-02','planned','{"visibility":"markaz"}','p-admin','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z');
INSERT INTO objects (id,markaz_id,kind,title,start_at,end_at,status,data,created_by,created_at,updated_at)
VALUES ('legacy-reversed-trip','markaz-surrey','jamaat','Synthetic reversed historical trip','2026-10-04','2026-10-02','planning','{}','p-admin','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z');
