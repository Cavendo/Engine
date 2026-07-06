-- Allow blocked/deferred in tasks.status check constraint (PostgreSQL).

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'assigned', 'in_progress', 'review', 'blocked', 'deferred', 'completed', 'cancelled'));
