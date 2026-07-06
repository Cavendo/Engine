-- Add session hardening fields: token hash storage, idle tracking, and metadata.
ALTER TABLE sessions ADD COLUMN token_hash TEXT;
ALTER TABLE sessions ADD COLUMN last_activity_at TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN ip_address TEXT;
ALTER TABLE sessions ADD COLUMN revoked_at TEXT;

UPDATE sessions
SET last_activity_at = COALESCE(last_activity_at, datetime('now'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
