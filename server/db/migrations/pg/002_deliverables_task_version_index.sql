-- Add composite (task_id, version DESC) index for latest-version lookups
CREATE INDEX IF NOT EXISTS idx_deliverables_task_version ON deliverables(task_id, version DESC);
