-- Issue #15: Prevent duplicate (task_id, version) pairs on deliverables.
-- MySQL UNIQUE allows multiple NULLs for task_id, matching desired semantics.

CREATE UNIQUE INDEX idx_deliverables_task_version_unique
  ON deliverables(task_id, version);
