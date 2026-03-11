-- Cavendo Engine Database Schema (MySQL 8)
-- Version: 0.1.1
--
-- Table creation order respects FK dependencies.

-- ============================================
-- Tables (dependency order)
-- ============================================

-- Users table (no FK deps)
CREATE TABLE IF NOT EXISTS users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    role VARCHAR(32) DEFAULT 'reviewer' CHECK (role IN ('admin', 'reviewer', 'viewer')),
    status VARCHAR(32) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    force_password_change TINYINT(1) DEFAULT 0 CHECK (force_password_change IN (0, 1)),
    last_login_at DATETIME(3),
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Agents table (depends on users)
CREATE TABLE IF NOT EXISTS agents (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (type IN ('autonomous', 'semi-autonomous', 'supervised')),
    description TEXT,
    capabilities LONGTEXT,
    specializations LONGTEXT,
    status VARCHAR(32) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
    webhook_url VARCHAR(500),
    webhook_secret TEXT,
    webhook_events LONGTEXT,
    max_concurrent_tasks INT DEFAULT 5,
    active_task_count INT DEFAULT 0,
    metadata LONGTEXT,
    owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    provider VARCHAR(64),
    provider_api_key_encrypted TEXT,
    provider_api_key_iv TEXT,
    encryption_key_version INT DEFAULT NULL,
    provider_model VARCHAR(255),
    provider_base_url VARCHAR(500),
    provider_label VARCHAR(100),
    system_prompt LONGTEXT,
    execution_mode VARCHAR(32) DEFAULT 'manual' CHECK (execution_mode IN ('manual', 'auto', 'polling', 'human')),
    max_tokens INT DEFAULT 4096,
    temperature DOUBLE DEFAULT 0.7,
    agent_type VARCHAR(64) DEFAULT 'general',
    specialization VARCHAR(255),
    project_access LONGTEXT DEFAULT '["*"]',
    task_types LONGTEXT DEFAULT '["*"]',
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Projects table (depends on agents)
CREATE TABLE IF NOT EXISTS projects (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(32) DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
    task_routing_rules LONGTEXT,
    default_agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Agent API keys table
CREATE TABLE IF NOT EXISTS agent_keys (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(64) NOT NULL,
    name VARCHAR(255),
    scopes LONGTEXT DEFAULT '["read","write"]',
    last_used_at DATETIME(3),
    expires_at DATETIME(3),
    revoked_at DATETIME(3),
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Sprints table
CREATE TABLE IF NOT EXISTS sprints (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
    status VARCHAR(32) DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'completed', 'cancelled')),
    start_date DATETIME(3),
    end_date DATETIME(3),
    goal TEXT,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
    sprint_id BIGINT REFERENCES sprints(id) ON DELETE SET NULL,
    assigned_agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
    title VARCHAR(500) NOT NULL,
    description LONGTEXT,
    tags LONGTEXT,
    status VARCHAR(32) DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'review', 'completed', 'cancelled')),
    priority INT DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
    context LONGTEXT,
    due_date DATETIME(3),
    assigned_at DATETIME(3),
    started_at DATETIME(3),
    completed_at DATETIME(3),
    routing_rule_id VARCHAR(255),
    routing_decision TEXT,
    task_type VARCHAR(128),
    required_capabilities LONGTEXT,
    preferred_agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Deliverables table
CREATE TABLE IF NOT EXISTS deliverables (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
    project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
    agent_id BIGINT REFERENCES agents(id) ON DELETE SET NULL,
    submitted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    title VARCHAR(500) NOT NULL,
    summary TEXT,
    content LONGTEXT,
    content_type VARCHAR(32) DEFAULT 'markdown' CHECK (content_type IN ('markdown', 'html', 'json', 'text', 'code')),
    files LONGTEXT,
    actions LONGTEXT,
    status VARCHAR(32) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revision_requested', 'revised', 'rejected')),
    version INT DEFAULT 1,
    parent_id BIGINT REFERENCES deliverables(id) ON DELETE SET NULL,
    reviewed_by VARCHAR(255),
    reviewed_at DATETIME(3),
    feedback LONGTEXT,
    metadata LONGTEXT,
    input_tokens INT,
    output_tokens INT,
    provider VARCHAR(64),
    model VARCHAR(255),
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Knowledge base table
CREATE TABLE IF NOT EXISTS knowledge (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    content LONGTEXT NOT NULL,
    content_type VARCHAR(32) DEFAULT 'markdown' CHECK (content_type IN ('markdown', 'html', 'json', 'text')),
    category VARCHAR(255),
    tags LONGTEXT,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Webhooks table
CREATE TABLE IF NOT EXISTS webhooks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id BIGINT REFERENCES agents(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL,
    secret TEXT NOT NULL,
    events LONGTEXT NOT NULL,
    status VARCHAR(32) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Webhook deliveries table
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    webhook_id BIGINT REFERENCES webhooks(id) ON DELETE CASCADE,
    agent_id BIGINT REFERENCES agents(id) ON DELETE CASCADE,
    event_type VARCHAR(128) NOT NULL,
    payload LONGTEXT NOT NULL,
    status VARCHAR(32) DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INT DEFAULT 0,
    last_attempt_at DATETIME(3),
    response_status INT,
    response_body LONGTEXT,
    error TEXT,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Agent activity log
CREATE TABLE IF NOT EXISTS agent_activity (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    action VARCHAR(128) NOT NULL,
    resource_type VARCHAR(64),
    resource_id BIGINT,
    details LONGTEXT,
    ip_address VARCHAR(128),
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Task progress log
CREATE TABLE IF NOT EXISTS task_progress (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    percent_complete INT CHECK (percent_complete IS NULL OR (percent_complete >= 0 AND percent_complete <= 100)),
    details LONGTEXT,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(255) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- User API keys table
CREATE TABLE IF NOT EXISTS user_keys (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(64) NOT NULL,
    name VARCHAR(255),
    last_used_at DATETIME(3),
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    content LONGTEXT NOT NULL,
    commentable_type VARCHAR(32) NOT NULL CHECK (commentable_type IN ('task', 'deliverable')),
    commentable_id BIGINT NOT NULL,
    author_type VARCHAR(32) NOT NULL CHECK (author_type IN ('user', 'agent')),
    author_id BIGINT NOT NULL,
    author_name VARCHAR(255) NOT NULL,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Routes table
CREATE TABLE IF NOT EXISTS routes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    trigger_event VARCHAR(128) NOT NULL,
    trigger_conditions LONGTEXT,
    destination_type VARCHAR(64) NOT NULL,
    destination_config LONGTEXT NOT NULL,
    field_mapping LONGTEXT,
    retry_policy LONGTEXT DEFAULT '{"max_retries": 3, "backoff_type": "exponential", "initial_delay_ms": 1000}',
    enabled TINYINT(1) DEFAULT 1,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Delivery logs table
CREATE TABLE IF NOT EXISTS delivery_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    route_id BIGINT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    deliverable_id BIGINT REFERENCES deliverables(id) ON DELETE SET NULL,
    event_type VARCHAR(128) NOT NULL,
    event_payload LONGTEXT NOT NULL,
    status VARCHAR(32) DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
    attempt_number INT DEFAULT 1,
    response_status INT,
    response_body LONGTEXT,
    error_message TEXT,
    dispatched_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    completed_at DATETIME(3),
    duration_ms INT,
    next_retry_at DATETIME(3)
);

-- Universal activity log
CREATE TABLE IF NOT EXISTS activity_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entity_type VARCHAR(64) NOT NULL,
    entity_id BIGINT NOT NULL,
    event_type VARCHAR(128) NOT NULL,
    actor_name VARCHAR(255),
    detail TEXT,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Storage connections table
CREATE TABLE IF NOT EXISTS storage_connections (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    provider VARCHAR(32) NOT NULL DEFAULT 's3',
    bucket VARCHAR(255) NOT NULL,
    region VARCHAR(64) DEFAULT 'us-east-1',
    endpoint VARCHAR(500),
    access_key_id_encrypted TEXT NOT NULL,
    access_key_id_iv TEXT NOT NULL,
    access_key_id_key_version INT DEFAULT NULL,
    access_key_id_preview VARCHAR(255) NOT NULL,
    secret_access_key_encrypted TEXT NOT NULL,
    secret_access_key_iv TEXT NOT NULL,
    secret_access_key_key_version INT DEFAULT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Runtime skill invocations
CREATE TABLE IF NOT EXISTS skill_invocations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    actor_type VARCHAR(32) NOT NULL,
    actor_id VARCHAR(255) NOT NULL,
    workspace_id BIGINT,
    task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
    workflow_run_id VARCHAR(255),
    workflow_step_id VARCHAR(255),
    provider VARCHAR(64) NOT NULL DEFAULT 'http_worker',
    skill_key VARCHAR(255) NOT NULL,
    skill_version VARCHAR(64),
    input_json LONGTEXT NOT NULL,
    context_json LONGTEXT,
    output_json LONGTEXT,
    status VARCHAR(32) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
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
    CHECK (
      (actor_type = 'user' AND actor_id LIKE 'user:%') OR
      (actor_type = 'system' AND actor_id LIKE 'system:%')
    ),
    UNIQUE(actor_type, actor_id, idempotency_key)
);

-- Runtime skill invocation artifacts
CREATE TABLE IF NOT EXISTS skill_invocation_artifacts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    skill_invocation_id BIGINT NOT NULL REFERENCES skill_invocations(id) ON DELETE CASCADE,
    artifact_type VARCHAR(128) NOT NULL,
    uri VARCHAR(1024) NOT NULL,
    metadata_json LONGTEXT,
    created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

-- Runtime skill policies
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

-- ============================================
-- Indexes
-- ============================================

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned_agent ON tasks(assigned_agent_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_priority_status ON tasks(priority, status);
CREATE INDEX idx_deliverables_task ON deliverables(task_id);
CREATE INDEX idx_deliverables_project ON deliverables(project_id);
CREATE INDEX idx_deliverables_status ON deliverables(status);
CREATE INDEX idx_deliverables_agent ON deliverables(agent_id);
CREATE INDEX idx_deliverables_user ON deliverables(submitted_by_user_id);
CREATE INDEX idx_agent_keys_hash ON agent_keys(key_hash);
CREATE INDEX idx_agent_keys_prefix ON agent_keys(key_prefix);
CREATE INDEX idx_knowledge_project ON knowledge(project_id);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX idx_agent_activity_agent ON agent_activity(agent_id);
CREATE INDEX idx_agent_activity_created ON agent_activity(created_at);
CREATE INDEX idx_task_progress_task ON task_progress(task_id);
CREATE INDEX idx_task_progress_created ON task_progress(created_at);
CREATE INDEX idx_agents_owner ON agents(owner_user_id);
CREATE INDEX idx_user_keys_user ON user_keys(user_id);
CREATE INDEX idx_user_keys_hash ON user_keys(key_hash);
CREATE INDEX idx_user_keys_prefix ON user_keys(key_prefix);
CREATE INDEX idx_comments_target ON comments(commentable_type, commentable_id);
CREATE INDEX idx_sprints_project ON sprints(project_id);
CREATE INDEX idx_sprints_status ON sprints(status);
CREATE INDEX idx_tasks_sprint ON tasks(sprint_id);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_webhooks_agent ON webhooks(agent_id);
CREATE INDEX idx_webhooks_status ON webhooks(status);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_deliverables_parent ON deliverables(parent_id);
CREATE INDEX idx_knowledge_category ON knowledge(category);

CREATE INDEX idx_routes_project ON routes(project_id);
CREATE INDEX idx_routes_trigger ON routes(project_id, trigger_event);
CREATE INDEX idx_routes_enabled ON routes(project_id, trigger_event, enabled);
CREATE INDEX idx_routes_global_trigger ON routes(trigger_event, project_id);

CREATE INDEX idx_delivery_logs_route ON delivery_logs(route_id, dispatched_at DESC);
CREATE INDEX idx_delivery_logs_status ON delivery_logs(status);
CREATE INDEX idx_delivery_logs_deliverable ON delivery_logs(deliverable_id);
CREATE INDEX idx_delivery_logs_retry ON delivery_logs(status, next_retry_at);

CREATE INDEX idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_created ON activity_log(created_at);

CREATE INDEX idx_agents_active ON agents(status);
CREATE INDEX idx_agents_capacity ON agents(active_task_count, max_concurrent_tasks);

CREATE INDEX idx_tasks_tags ON tasks(tags(255));
CREATE INDEX idx_tasks_task_type ON tasks(task_type);
CREATE INDEX idx_tasks_preferred_agent ON tasks(preferred_agent_id);
CREATE INDEX idx_projects_default_agent ON projects(default_agent_id);

CREATE INDEX idx_agents_agent_type ON agents(agent_type);
CREATE INDEX idx_agents_specialization ON agents(specialization);

CREATE INDEX idx_storage_connections_name ON storage_connections(name);
