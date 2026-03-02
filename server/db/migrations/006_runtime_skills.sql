CREATE TABLE IF NOT EXISTS skill_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  workspace_id INTEGER,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  workflow_run_id TEXT,
  workflow_step_id TEXT,
  provider TEXT NOT NULL DEFAULT 'http_worker',
  skill_key TEXT NOT NULL,
  skill_version TEXT,
  input_json TEXT NOT NULL,
  context_json TEXT,
  output_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
  external_invocation_id TEXT,
  error_code TEXT,
  error_message TEXT,
  error_detail_json TEXT,
  cost_units REAL,
  cost_currency TEXT,
  queued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  timed_out_at TEXT,
  cancelled_at TEXT,
  cancel_requested_at TEXT,
  cancel_request_error_json TEXT,
  last_polled_at TEXT,
  next_poll_at TEXT,
  timeout_at TEXT,
  poll_claimed_by TEXT,
  poll_claimed_until TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  CHECK (
    (actor_type = 'user' AND actor_id LIKE 'user:%') OR
    (actor_type = 'system' AND actor_id LIKE 'system:%')
  ),
  UNIQUE(actor_type, actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS skill_invocation_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_invocation_id INTEGER NOT NULL REFERENCES skill_invocations(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  uri TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runtime_skill_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_key TEXT NOT NULL,
  role TEXT NOT NULL,
  workspace_id INTEGER,
  allow_catalog INTEGER NOT NULL DEFAULT 0,
  allow_invoke INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skill_invocations_status_next_poll ON skill_invocations(status, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_external_id ON skill_invocations(external_invocation_id);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_actor_created ON skill_invocations(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_invocation_artifacts_invocation_id ON skill_invocation_artifacts(skill_invocation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_skill_policies_unique_ws ON runtime_skill_policies(skill_key, role, workspace_id) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_skill_policies_unique_global ON runtime_skill_policies(skill_key, role) WHERE workspace_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_runtime_skill_policies_lookup ON runtime_skill_policies(skill_key, role, workspace_id);

INSERT OR IGNORE INTO runtime_skill_policies (skill_key, role, workspace_id, allow_catalog, allow_invoke)
VALUES ('*', 'admin', NULL, 1, 1);
