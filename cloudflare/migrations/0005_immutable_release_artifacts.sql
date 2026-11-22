ALTER TABLE releases ADD COLUMN object_etag TEXT;

CREATE TRIGGER IF NOT EXISTS immutable_release_artifact
BEFORE UPDATE ON releases
WHEN NEW.id IS NOT OLD.id
  OR NEW.app_id IS NOT OLD.app_id
  OR NEW.channel IS NOT OLD.channel
  OR NEW.version IS NOT OLD.version
  OR NEW.build_number IS NOT OLD.build_number
  OR NEW.object_key IS NOT OLD.object_key
  OR NEW.filename IS NOT OLD.filename
  OR NEW.content_type IS NOT OLD.content_type
  OR NEW.size_bytes IS NOT OLD.size_bytes
  OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.commit_sha IS NOT OLD.commit_sha
  OR NEW.object_etag IS NOT OLD.object_etag
BEGIN
  SELECT RAISE(ABORT, 'release identity conflict');
END;
