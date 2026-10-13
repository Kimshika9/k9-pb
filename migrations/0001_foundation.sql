PRAGMA foreign_keys = ON;
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  telegram_chat_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  username TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE posts (
  id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  document_json TEXT NOT NULL DEFAULT '{"version":1,"blocks":[]}' CHECK (json_valid(document_json)),
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','failed')),
  telegram_message_id INTEGER,
  scheduled_at TEXT, published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE media (
  id TEXT PRIMARY KEY, post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  telegram_file_id TEXT, storage_key TEXT,
  mime_type TEXT NOT NULL, original_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (telegram_file_id IS NOT NULL OR storage_key IS NOT NULL)
);
CREATE TABLE history (
  id TEXT PRIMARY KEY, post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  actor_telegram_id TEXT NOT NULL, action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until TEXT, last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE webhook_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
  lease_until INTEGER NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX posts_status_updated ON posts(status, updated_at DESC);
CREATE INDEX history_created ON history(created_at DESC);
CREATE INDEX scheduled_jobs_due ON scheduled_jobs(status, run_at);
CREATE UNIQUE INDEX scheduled_jobs_live_post ON scheduled_jobs(post_id) WHERE status IN ('pending','running');
CREATE INDEX media_post ON media(post_id);
-- Defense in depth: no scheduled or published post can target an unapproved channel.
CREATE TRIGGER posts_approved_insert BEFORE INSERT ON posts
WHEN NEW.status IN ('scheduled','published') AND NOT EXISTS (
  SELECT 1 FROM channels WHERE id = NEW.channel_id AND active = 1 AND approved_at IS NOT NULL
) BEGIN SELECT RAISE(ABORT, 'Channel is not approved'); END;
CREATE TRIGGER posts_approved_update BEFORE UPDATE ON posts
WHEN NEW.status IN ('scheduled','published') AND NOT EXISTS (
  SELECT 1 FROM channels WHERE id = NEW.channel_id AND active = 1 AND approved_at IS NOT NULL
) BEGIN SELECT RAISE(ABORT, 'Channel is not approved'); END;
CREATE TRIGGER jobs_approved_insert BEFORE INSERT ON scheduled_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM posts p JOIN channels c ON c.id = p.channel_id
  WHERE p.id = NEW.post_id AND c.active = 1 AND c.approved_at IS NOT NULL
) BEGIN SELECT RAISE(ABORT, 'Channel is not approved'); END;
