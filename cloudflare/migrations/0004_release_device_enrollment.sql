CREATE TABLE IF NOT EXISTS release_distribution (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('public', 'private')),
  changed_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO release_distribution (singleton, mode, changed_at) VALUES (1, 'public', unixepoch());

CREATE TABLE IF NOT EXISTS release_devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enrollment_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  credential_hash TEXT,
  enrolled_at INTEGER,
  used_at INTEGER,
  revoked_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK ((credential_hash IS NULL) = (enrolled_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_release_devices_enrollment ON release_devices (enrolled_at, revoked_at, used_at);
