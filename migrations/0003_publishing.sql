-- Phase 3 is additive: preserve source drafts and legacy publication metadata.
CREATE TABLE publications (
 id TEXT PRIMARY KEY,
 post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
 edit_draft_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
 origin_post_id TEXT NOT NULL,
 channel_id TEXT REFERENCES channels(id) ON DELETE RESTRICT,
 owner_telegram_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('publication','preview')),
 title TEXT NOT NULL,
 document_json TEXT NOT NULL CHECK(json_valid(document_json)),
 source_revision INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
 status TEXT NOT NULL CHECK(status IN ('preparing','sending','published','failed','uncertain','deleted')),
 telegram_message_id INTEGER,
 telegram_chat_id TEXT,
 message_url TEXT,
 operation_id TEXT NOT NULL,
 active_operation_id TEXT,
 last_operation_id TEXT,
 delivery_key TEXT UNIQUE,
 last_error_code TEXT,
 published_at TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX publications_owner_created ON publications(owner_telegram_id,created_at DESC);
CREATE UNIQUE INDEX publications_active_source ON publications(origin_post_id,source_revision,coalesce(channel_id,''),kind)
 WHERE status IN ('preparing','sending');
CREATE TABLE publishing_operations (
 id TEXT PRIMARY KEY,
 owner_telegram_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('publish','preview','republish','edit','delete','schedule','legacy')),
 fingerprint TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 publication_id TEXT REFERENCES publications(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN ('preparing','sending','succeeded','failed','uncertain')),
 lease_token TEXT NOT NULL,
 lease_until INTEGER NOT NULL,
 retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
 retry_after INTEGER NOT NULL DEFAULT 0,
 last_error_code TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX operations_leases ON publishing_operations(status,lease_until);
CREATE TABLE cli_nonces (
 nonce TEXT PRIMARY KEY,
 owner_telegram_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX cli_nonces_expiry ON cli_nonces(expires_at);
CREATE TABLE scheduler_state (
 id TEXT PRIMARY KEY CHECK(id='cron'),
 last_run_at TEXT NOT NULL,
 last_error_code TEXT
);
ALTER TABLE scheduled_jobs ADD COLUMN channel_id TEXT REFERENCES channels(id);
ALTER TABLE scheduled_jobs ADD COLUMN owner_telegram_id TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN document_json TEXT CHECK(document_json IS NULL OR json_valid(document_json));
ALTER TABLE scheduled_jobs ADD COLUMN title TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN source_revision INTEGER;
ALTER TABLE scheduled_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scheduled_jobs ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE scheduled_jobs ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'legacy_review'
 CHECK(delivery_state IN ('legacy_review','waiting','preparing','sending','delivered','rejected','uncertain','cancelled'));
ALTER TABLE scheduled_jobs ADD COLUMN operation_id TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN publication_id TEXT REFERENCES publications(id);
UPDATE scheduled_jobs SET channel_id=(SELECT channel_id FROM posts WHERE posts.id=scheduled_jobs.post_id);
DROP INDEX scheduled_jobs_live_post;
CREATE UNIQUE INDEX scheduled_jobs_live_channel ON scheduled_jobs(post_id,coalesce(channel_id,'')) WHERE status IN ('pending','running');
CREATE INDEX scheduled_jobs_owner_due ON scheduled_jobs(owner_telegram_id,status,run_at);
DROP TRIGGER jobs_approved_insert;
CREATE TRIGGER jobs_approved_insert BEFORE INSERT ON scheduled_jobs
 WHEN NOT EXISTS(SELECT 1 FROM posts p JOIN channels c ON c.id=coalesce(NEW.channel_id,p.channel_id)
 WHERE p.id=NEW.post_id AND c.active=1 AND c.approved_at IS NOT NULL AND (NEW.owner_telegram_id IS NULL OR c.approved_by=NEW.owner_telegram_id))
 BEGIN SELECT RAISE(ABORT,'Channel is not approved'); END;
CREATE TRIGGER publications_approved_insert BEFORE INSERT ON publications
 WHEN NEW.kind='publication' AND NEW.status IN ('preparing','sending') AND NOT EXISTS(
 SELECT 1 FROM channels WHERE id=NEW.channel_id AND active=1 AND approved_at IS NOT NULL AND approved_by=NEW.owner_telegram_id)
 BEGIN SELECT RAISE(ABORT,'Channel is not approved'); END;
-- Preserve previously published records. Legacy scheduled jobs need explicit owner review.
INSERT INTO publications(id,post_id,origin_post_id,channel_id,owner_telegram_id,kind,title,document_json,source_revision,status,telegram_message_id,telegram_chat_id,operation_id,published_at,delivery_key)
 SELECT 'legacy-'||p.id,p.id,p.id,p.channel_id,coalesce(p.owner_telegram_id,c.approved_by),'publication',p.title,p.document_json,p.revision,'published',p.telegram_message_id,c.telegram_chat_id,'legacy-'||p.id,p.published_at,p.id||':'||p.revision||':'||p.channel_id
 FROM posts p JOIN channels c ON c.id=p.channel_id WHERE p.status='published' AND p.telegram_message_id IS NOT NULL;
INSERT INTO publishing_operations(id,owner_telegram_id,kind,fingerprint,request_json,publication_id,status,lease_token,lease_until)
 SELECT operation_id,owner_telegram_id,'legacy','legacy',json_object('snapshot',json_object('postId',origin_post_id,'title',title,'revision',source_revision,'document',json(document_json))),id,'succeeded','legacy',0 FROM publications WHERE id LIKE 'legacy-%';
