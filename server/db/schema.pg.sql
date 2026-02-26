-- Cavendo Engine Database Schema (PostgreSQL)
-- Version: 0.1.0
--
-- Table creation order respects FK dependencies.
-- Circular references (projects↔agents↔users) are resolved by
-- creating tables first without the cross-reference columns,
-- then adding them via ALTER TABLE at the end.

-- ============================================
-- Tables (dependency order)
-- ============================================

-- Users table (no FK deps)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'reviewer' CHECK (role IN ('admin', 'reviewer', 'viewer')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    force_password_change INTEGER DEFAULT 0 CHECK (force_password_change IN (0, 1)),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agents table (depends on users)
CREATE TABLE IF NOT EXISTS agents (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('autonomous', 'semi-autonomous', 'supervised')),
    description TEXT,
    capabilities TEXT,
    specializations TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
    webhook_url TEXT,
    webhook_secret TEXT,
    webhook_events TEXT,
    max_concurrent_tasks INTEGER DEFAULT 5,
    active_task_count INTEGER DEFAULT 0,
    metadata TEXT,
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    provider TEXT,
    provider_api_key_encrypted TEXT,
    provider_api_key_iv TEXT,
    encryption_key_version INTEGER DEFAULT NULL,
    provider_model TEXT,
    provider_base_url TEXT,
    provider_label TEXT,
    system_prompt TEXT,
    execution_mode TEXT DEFAULT 'manual' CHECK (execution_mode IN ('manual', 'auto', 'polling', 'human')),
    max_tokens INTEGER DEFAULT 4096,
    temperature REAL DEFAULT 0.7,
    agent_type TEXT DEFAULT 'general',
    specialization TEXT,
    project_access TEXT DEFAULT '["*"]',
    task_types TEXT DEFAULT '["*"]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects table (depends on agents)
CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
    task_routing_rules TEXT,
    default_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent API keys table
CREATE TABLE IF NOT EXISTS agent_keys (
    id SERIAL PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT,
    scopes TEXT DEFAULT '["read","write"]',
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sprints table
CREATE TABLE IF NOT EXISTS sprints (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'completed', 'cancelled')),
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    goal TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
    assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'review', 'completed', 'cancelled')),
    priority INTEGER DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
    context TEXT,
    due_date TIMESTAMPTZ,
    assigned_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    routing_rule_id TEXT,
    routing_decision TEXT,
    task_type TEXT,
    required_capabilities TEXT,
    preferred_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deliverables table
CREATE TABLE IF NOT EXISTS deliverables (
    id SERIAL PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    summary TEXT,
    content TEXT,
    content_type TEXT DEFAULT 'markdown' CHECK (content_type IN ('markdown', 'html', 'json', 'text', 'code')),
    files TEXT,
    actions TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revision_requested', 'revised', 'rejected')),
    version INTEGER DEFAULT 1,
    parent_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    feedback TEXT,
    metadata TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    provider TEXT,
    model TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Knowledge base table
CREATE TABLE IF NOT EXISTS knowledge (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT DEFAULT 'markdown' CHECK (content_type IN ('markdown', 'html', 'json', 'text')),
    category TEXT,
    tags TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhooks table
CREATE TABLE IF NOT EXISTS webhooks (
    id SERIAL PRIMARY KEY,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook deliveries table
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id SERIAL PRIMARY KEY,
    webhook_id INTEGER REFERENCES webhooks(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    response_status INTEGER,
    response_body TEXT,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent activity log
CREATE TABLE IF NOT EXISTS agent_activity (
    id SERIAL PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id INTEGER,
    details TEXT,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Task progress log
CREATE TABLE IF NOT EXISTS task_progress (
    id SERIAL PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    percent_complete INTEGER CHECK (percent_complete IS NULL OR (percent_complete >= 0 AND percent_complete <= 100)),
    details TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- User API keys table
CREATE TABLE IF NOT EXISTS user_keys (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    commentable_type TEXT NOT NULL CHECK (commentable_type IN ('task', 'deliverable')),
    commentable_id INTEGER NOT NULL,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Routes table
CREATE TABLE IF NOT EXISTS routes (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    trigger_event TEXT NOT NULL,
    trigger_conditions TEXT,
    destination_type TEXT NOT NULL,
    destination_config TEXT NOT NULL,
    field_mapping TEXT,
    retry_policy TEXT DEFAULT '{"max_retries": 3, "backoff_type": "exponential", "initial_delay_ms": 1000}',
    enabled INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Delivery logs table
CREATE TABLE IF NOT EXISTS delivery_logs (
    id SERIAL PRIMARY KEY,
    route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    event_payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
    attempt_number INTEGER DEFAULT 1,
    response_status INTEGER,
    response_body TEXT,
    error_message TEXT,
    dispatched_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    next_retry_at TIMESTAMPTZ
);

-- Universal activity log
CREATE TABLE IF NOT EXISTS activity_log (
    id SERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor_name TEXT,
    detail TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Storage connections table
CREATE TABLE IF NOT EXISTS storage_connections (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 's3',
    bucket TEXT NOT NULL,
    region TEXT DEFAULT 'us-east-1',
    endpoint TEXT,
    access_key_id_encrypted TEXT NOT NULL,
    access_key_id_iv TEXT NOT NULL,
    access_key_id_key_version INTEGER DEFAULT NULL,
    access_key_id_preview TEXT NOT NULL,
    secret_access_key_encrypted TEXT NOT NULL,
    secret_access_key_iv TEXT NOT NULL,
    secret_access_key_key_version INTEGER DEFAULT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- Indexes
-- ============================================

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_status ON tasks(priority, status);
CREATE INDEX IF NOT EXISTS idx_deliverables_task ON deliverables(task_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_task_version ON deliverables(task_id, version DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverables_task_version_unique
  ON deliverables(task_id, version) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_status ON deliverables(status);
CREATE INDEX IF NOT EXISTS idx_deliverables_agent ON deliverables(agent_id);
CREATE INDEX IF NOT EXISTS idx_deliverables_user ON deliverables(submitted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_keys_hash ON agent_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_agent_keys_prefix ON agent_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_agent_activity_agent ON agent_activity(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON agent_activity(created_at);
CREATE INDEX IF NOT EXISTS idx_task_progress_task ON task_progress(task_id);
CREATE INDEX IF NOT EXISTS idx_task_progress_created ON task_progress(created_at);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_user_keys_user ON user_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_user_keys_hash ON user_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_user_keys_prefix ON user_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(commentable_type, commentable_id);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id);
CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_status ON webhooks(status);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_deliverables_parent ON deliverables(parent_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);

CREATE INDEX IF NOT EXISTS idx_routes_project ON routes(project_id);
CREATE INDEX IF NOT EXISTS idx_routes_trigger ON routes(project_id, trigger_event);
CREATE INDEX IF NOT EXISTS idx_routes_enabled ON routes(project_id, trigger_event, enabled);
CREATE INDEX IF NOT EXISTS idx_routes_global_trigger ON routes(trigger_event) WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_logs_route ON delivery_logs(route_id, dispatched_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_status ON delivery_logs(status);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_deliverable ON delivery_logs(deliverable_id);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_retry ON delivery_logs(status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agents_capacity ON agents(active_task_count, max_concurrent_tasks);

CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks(tags);
CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_preferred_agent ON tasks(preferred_agent_id);
CREATE INDEX IF NOT EXISTS idx_projects_default_agent ON projects(default_agent_id);

CREATE INDEX IF NOT EXISTS idx_agents_agent_type ON agents(agent_type);
CREATE INDEX IF NOT EXISTS idx_agents_specialization ON agents(specialization);

CREATE INDEX IF NOT EXISTS idx_storage_connections_name ON storage_connections(name);
