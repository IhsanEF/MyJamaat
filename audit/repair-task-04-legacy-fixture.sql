-- Synthetic old records loaded before the forward migration. Never use on live data.
INSERT INTO objects (id,markaz_id,kind,parent_id,title,start_at,end_at,status,data,created_by,created_at,updated_at) VALUES
('legacy-approved-missing-member','markaz-surrey','jamaat',NULL,'Legacy approved Ameer missing membership','2026-10-02','2026-10-03','planning','{"kind":"regular","route":"","ameerId":"p-member","ameerStatus":"approved","pendingAmeerId":null}','p-admin','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z'),
('legacy-cross-tenant-ameer','markaz-surrey','jamaat',NULL,'Legacy cross-tenant Ameer','2026-10-02','2026-10-03','planning','{"kind":"regular","route":"","ameerId":"p-other-admin","ameerStatus":"approved","pendingAmeerId":null}','p-admin','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z');
INSERT INTO memberships (id,markaz_id,jamaat_id,person_id,role,permissions,created_at) VALUES
('legacy-approved-founder','markaz-surrey','legacy-approved-missing-member','p-admin','member','{}','2026-09-30T00:00:00.000Z'),
('legacy-cross-tenant-founder','markaz-surrey','legacy-cross-tenant-ameer','p-admin','member','{}','2026-09-30T00:00:00.000Z');
UPDATE memberships SET role = 'ameer', permissions = '{"manage":true,"viewContacts":true,"labels":["legacy draft"]}' WHERE jamaat_id = 'jamaat-pending' AND person_id = 'p-pending';
