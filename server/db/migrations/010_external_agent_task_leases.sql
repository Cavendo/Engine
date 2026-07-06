ALTER TABLE tasks ADD COLUMN agent_claimed_by TEXT;
ALTER TABLE tasks ADD COLUMN agent_claimed_at TEXT;
ALTER TABLE tasks ADD COLUMN agent_claim_expires_at TEXT;
ALTER TABLE tasks ADD COLUMN agent_last_heartbeat_at TEXT;
ALTER TABLE tasks ADD COLUMN external_execution_status TEXT;
ALTER TABLE tasks ADD COLUMN external_run_id TEXT;
ALTER TABLE tasks ADD COLUMN external_error TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_agent_claim_expires_at ON tasks(agent_claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_external_execution_status ON tasks(external_execution_status);
