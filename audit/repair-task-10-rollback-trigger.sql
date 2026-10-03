-- Disposable D1 only: force the second stop update to abort an otherwise valid batch.
CREATE TRIGGER synthetic_route_failure BEFORE UPDATE OF start_at ON objects
WHEN OLD.id = 'stay-2' AND NEW.start_at <> OLD.start_at
BEGIN
  SELECT RAISE(ABORT, 'synthetic route rollback');
END;
