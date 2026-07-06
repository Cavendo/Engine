ALTER TABLE users ADD COLUMN IF NOT EXISTS is_agent_user INTEGER DEFAULT 0 CHECK (is_agent_user IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_users_is_agent_user ON users(is_agent_user);
