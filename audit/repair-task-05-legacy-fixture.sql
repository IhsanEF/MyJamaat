-- Disposable synthetic legacy rows. Apply after fixture.sql and before 0002.
INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at)
VALUES ('legacy-invalid-assignment','markaz-surrey','assignment','jamaat-weekend','Legacy invalid helper','planned','{"amal":"Khidmah","date":"2026-10-02","personId":"p-other-admin","details":"Review original duty before reassigning."}','p-admin','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z');
INSERT INTO objects (id,markaz_id,kind,parent_id,title,start_at,status,data,created_by,created_at,updated_at)
VALUES ('daily-legacy-invalid','markaz-surrey','mashwara','jamaat-weekend','Legacy day plan','2026-10-02','planned','{"daily":true,"date":"2026-10-02","ameerId":"p-other-admin","visibility":"jamaat"}','p-admin','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z');
INSERT INTO objects (id,markaz_id,kind,parent_id,title,status,data,created_by,created_at,updated_at)
VALUES ('legacy-invalid-daily-amal','markaz-surrey','umoor','daily-legacy-invalid','Fajr Bayaan','open','{"builtin":true,"amal":"Fajr Bayaan","active":true,"personIds":["p-member","p-other-admin"],"notes":"Keep valid helper only."}','p-admin','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z');
