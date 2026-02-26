-- Issue #15: Prevent duplicate (task_id, version) pairs on deliverables.
-- If this migration fails with a UNIQUE constraint error, existing duplicate rows
-- must be resolved first. Run:
--   SELECT task_id, version, COUNT(*) FROM deliverables
--     WHERE task_id IS NOT NULL GROUP BY task_id, version HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverables_task_version_unique
  ON deliverables(task_id, version) WHERE task_id IS NOT NULL;
