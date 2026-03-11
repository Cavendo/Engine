CREATE TABLE IF NOT EXISTS skill_invocations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_type VARCHAR(32) NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  workspace_id BIGINT,
  task_id BIGINT,
  workflow_run_id VARCHAR(255),
  workflow_step_id VARCHAR(255),
  provider VARCHAR(64) NOT NULL DEFAULT 'http_worker',
  skill_key VARCHAR(255) NOT NULL,
  skill_version VARCHAR(64),
  input_json LONGTEXT NOT NULL,
  context_json LONGTEXT,
  output_json LONGTEXT,
  status VARCHAR(32) NOT NULL,
  external_invocation_id VARCHAR(255),
  error_code VARCHAR(64),
  error_message TEXT,
  error_detail_json LONGTEXT,
  cost_units DOUBLE,
  cost_currency VARCHAR(16),
  queued_at DATETIME(3),
  started_at DATETIME(3),
  completed_at DATETIME(3),
  timed_out_at DATETIME(3),
  cancelled_at DATETIME(3),
  cancel_requested_at DATETIME(3),
  cancel_request_error_json LONGTEXT,
  last_polled_at DATETIME(3),
  next_poll_at DATETIME(3),
  timeout_at DATETIME(3),
  poll_claimed_by VARCHAR(255),
  poll_claimed_until DATETIME(3),
  idempotency_key VARCHAR(255) NOT NULL,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_skill_invocations_status CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
  CONSTRAINT chk_skill_invocations_actor CHECK (
    (actor_type = 'user' AND actor_id LIKE 'user:%') OR
    (actor_type = 'system' AND actor_id LIKE 'system:%')
  ),
  CONSTRAINT fk_skill_invocations_task
    FOREIGN KEY (task_id) REFERENCES tasks(id)
    ON DELETE SET NULL,
  UNIQUE KEY uq_skill_invocations_actor_idempotency (actor_type, actor_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS skill_invocation_artifacts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  skill_invocation_id BIGINT NOT NULL,
  artifact_type VARCHAR(128) NOT NULL,
  uri VARCHAR(1024) NOT NULL,
  metadata_json LONGTEXT,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_skill_invocation_artifacts_invocation
    FOREIGN KEY (skill_invocation_id) REFERENCES skill_invocations(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_skill_policies (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  skill_key VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL,
  workspace_id BIGINT,
  workspace_scope BIGINT GENERATED ALWAYS AS (IFNULL(workspace_id, -1)) STORED,
  allow_catalog TINYINT(1) NOT NULL DEFAULT 0,
  allow_invoke TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE INDEX idx_skill_invocations_status_next_poll ON skill_invocations(status, next_poll_at);
CREATE INDEX idx_skill_invocations_external_id ON skill_invocations(external_invocation_id);
CREATE INDEX idx_skill_invocations_actor_created ON skill_invocations(actor_id, created_at DESC);
CREATE INDEX idx_skill_invocation_artifacts_invocation_id ON skill_invocation_artifacts(skill_invocation_id);
CREATE UNIQUE INDEX idx_runtime_skill_policies_unique ON runtime_skill_policies(skill_key, role, workspace_scope);
CREATE INDEX idx_runtime_skill_policies_lookup ON runtime_skill_policies(skill_key, role, workspace_id);

INSERT IGNORE INTO runtime_skill_policies (skill_key, role, workspace_id, allow_catalog, allow_invoke)
VALUES ('*', 'admin', NULL, 1, 1);
