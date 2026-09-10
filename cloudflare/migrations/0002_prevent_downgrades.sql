CREATE TRIGGER IF NOT EXISTS prevent_active_release_insert_downgrade
BEFORE INSERT ON releases
WHEN NEW.is_active = 1 AND EXISTS (
  SELECT 1 FROM releases
  WHERE app_id = NEW.app_id AND channel = NEW.channel AND is_active = 1
    AND build_number > NEW.build_number
)
BEGIN
  SELECT RAISE(ABORT, 'release downgrade rejected');
END;

CREATE TRIGGER IF NOT EXISTS prevent_active_release_update_downgrade
BEFORE UPDATE OF build_number, is_active ON releases
WHEN NEW.is_active = 1 AND EXISTS (
  SELECT 1 FROM releases
  WHERE app_id = NEW.app_id AND channel = NEW.channel AND is_active = 1
    AND id <> NEW.id AND build_number > NEW.build_number
)
BEGIN
  SELECT RAISE(ABORT, 'release downgrade rejected');
END;
