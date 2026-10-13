-- Additive Phase 2 migration. Existing records and Phase 1 constraints are preserved.
ALTER TABLE posts ADD COLUMN owner_telegram_id TEXT;
ALTER TABLE posts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE templates ADD COLUMN owner_telegram_id TEXT;
ALTER TABLE templates ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE media ADD COLUMN owner_telegram_id TEXT;
ALTER TABLE media ADD COLUMN kind TEXT CHECK (kind IN ('photo','video','document'));
ALTER TABLE media ADD COLUMN file_unique_id TEXT;
ALTER TABLE media ADD COLUMN width INTEGER;
ALTER TABLE media ADD COLUMN height INTEGER;
ALTER TABLE media ADD COLUMN duration INTEGER;
CREATE INDEX posts_owner_drafts ON posts(owner_telegram_id, status, updated_at DESC);
CREATE INDEX templates_owner ON templates(owner_telegram_id, updated_at DESC);
CREATE UNIQUE INDEX media_owner_unique ON media(owner_telegram_id, file_unique_id) WHERE file_unique_id IS NOT NULL;
