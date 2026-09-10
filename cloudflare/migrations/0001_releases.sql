CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  build_number INTEGER NOT NULL CHECK (build_number > 0),
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta')),
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  commit_sha TEXT NOT NULL,
  release_notes TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_releases_latest
  ON releases (app_id, channel, is_active, build_number DESC, published_at DESC);
