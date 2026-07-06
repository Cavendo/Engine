ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_claimed_by TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_claimed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_claim_expires_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_execution_status TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_run_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS external_error TEXT;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_external_execution_status_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_external_execution_status_check
  CHECK (external_execution_status IN ('queued', 'accepted', 'running', 'blocked', 'needs_input', 'submitted', 'completed', 'failed', 'canceled'));

CREATE INDEX IF NOT EXISTS idx_tasks_agent_claim_expires_at ON tasks(agent_claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_external_execution_status ON tasks(external_execution_status);
