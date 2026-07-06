-- Allow completed external execution status on tasks (PostgreSQL).

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_external_execution_status_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_external_execution_status_check
  CHECK (external_execution_status IN ('queued', 'accepted', 'running', 'blocked', 'needs_input', 'submitted', 'completed', 'failed', 'canceled'));

CREATE INDEX IF NOT EXISTS idx_tasks_agent_claim_expires_at ON tasks(agent_claim_expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_external_execution_status ON tasks(external_execution_status);
