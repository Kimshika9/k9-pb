-- Phase 3.1: a single durable update-receiver fence, separate from publishing Cron.
CREATE TABLE bot_runtime (
 id TEXT PRIMARY KEY CHECK(id='receiver'),
 owner_telegram_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('cloudflare','python','transition')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 instance_id TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
CREATE TABLE bridge_rate_limits (
 id TEXT PRIMARY KEY,
 window INTEGER NOT NULL,
 count INTEGER NOT NULL CHECK(count>0)
);
