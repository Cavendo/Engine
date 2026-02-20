-- Cavendo Engine Database Schema
-- Version: 0.1.0

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
    -- Task routing configuration
    task_routing_rules TEXT, -- JSON array of routing rules
    default_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('autonomous', 'semi-autonomous', 'supervised')),
    description TEXT,
    capabilities TEXT, -- JSON array of capability strings
    specializations TEXT, -- JSON object: rich metadata (business_lines, content_types, etc.). See also: specialization (routing label)
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
    webhook_url TEXT,
    webhook_secret TEXT,
    webhook_events TEXT, -- JSON array of event types
    max_concurrent_tasks INTEGER DEFAULT 5,
    active_task_count INTEGER DEFAULT 0, -- Current in-progress tasks (maintained by Engine)
    metadata TEXT, -- JSON object for custom extensions
    -- User linking (for "my tasks" queries via MCP)
    owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    -- Outbound execution configuration
    provider TEXT, -- 'anthropic', 'openai', etc.
    provider_api_key_encrypted TEXT,
    provider_api_key_iv TEXT,
    encryption_key_version INTEGER DEFAULT NULL, -- Keyring version used for provider_api_key
    provider_model TEXT, -- 'claude-opus-4', 'gpt-4o', etc.
    system_prompt TEXT, -- Standing instructions for this agent
    execution_mode TEXT DEFAULT 'manual' CHECK (execution_mode IN ('manual', 'auto', 'polling', 'human')),
    max_tokens INTEGER DEFAULT 4096,
    temperature REAL DEFAULT 0.7,
    -- Agent routing/specialization fields
    agent_type TEXT DEFAULT 'general',
    specialization TEXT, -- Simple routing label (e.g. 'boardsite', 'seo'). NOT the same as specializations (JSON)
    project_access TEXT DEFAULT '["*"]', -- JSON array of project IDs or ["*"] for all
    task_types TEXT DEFAULT '["*"]', -- JSON array of task types or ["*"] for all
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Agent API keys table
CREATE TABLE IF NOT EXISTS agent_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL, -- First 8 chars for identification
    name TEXT, -- Optional key name for identification
    scopes TEXT DEFAULT '["read","write"]', -- JSON array of scopes
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Sprints table
CREATE TABLE IF NOT EXISTS sprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'completed', 'cancelled')),
    start_date TEXT,
    end_date TEXT,
    goal TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
    assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    tags TEXT, -- JSON array of tags for routing
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'review', 'completed', 'cancelled')),
    priority INTEGER DEFAULT 2 CHECK (priority BETWEEN 1 AND 4), -- 1=critical, 2=high, 3=medium, 4=low
    context TEXT, -- JSON object with additional context
    due_date TEXT,
    assigned_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    -- Routing decision tracking
    routing_rule_id TEXT, -- ID of rule that matched
    routing_decision TEXT, -- Human-readable routing explanation
    -- Task routing fields
    task_type TEXT,
    required_capabilities TEXT, -- JSON array of required capability strings
    preferred_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Deliverables table
CREATE TABLE IF NOT EXISTS deliverables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, -- Now optional for standalone deliverables
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, -- Direct project link (if no task)
    agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- User who submitted (for user key submissions)
    title TEXT NOT NULL,
    summary TEXT, -- Text summary/description shown in Overview tab
    content TEXT, -- Main content (optional if files provided)
    content_type TEXT DEFAULT 'markdown' CHECK (content_type IN ('markdown', 'html', 'json', 'text', 'code')),
    files TEXT, -- JSON array of file attachments [{filename, path, mimeType, size}]
    actions TEXT, -- JSON array of follow-up actions [{action_text, estimated_time_minutes, notes, completed}]
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revision_requested', 'revised', 'rejected')),
    version INTEGER DEFAULT 1,
    parent_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL, -- For revisions
    reviewed_by TEXT,
    reviewed_at TEXT,
    feedback TEXT,
    metadata TEXT, -- JSON object for additional metadata
    -- Token usage tracking for AI-generated deliverables
    input_tokens INTEGER, -- Tokens used for input/prompt
    output_tokens INTEGER, -- Tokens used for output/completion
    provider TEXT, -- AI provider used (anthropic, openai, etc.)
    model TEXT, -- Model used (claude-opus-4, gpt-4o, etc.)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Knowledge base table
CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT DEFAULT 'markdown' CHECK (content_type IN ('markdown', 'html', 'json', 'text')),
    category TEXT, -- Optional categorization
    tags TEXT, -- JSON array of tags
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Webhooks table (separate from agent inline webhook config for flexibility)
CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL, -- JSON array of event types
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Webhook deliveries table (for logging and retry)
-- webhook_id can be NULL for inline agent webhooks (configured via agents.webhook_url)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER REFERENCES webhooks(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE, -- For inline webhooks
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL, -- JSON payload
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    response_status INTEGER,
    response_body TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Agent activity log
CREATE TABLE IF NOT EXISTS agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    action TEXT NOT NULL, -- e.g., 'task.claimed', 'deliverable.submitted', 'api.called'
    resource_type TEXT, -- e.g., 'task', 'deliverable', 'knowledge'
    resource_id INTEGER,
    details TEXT, -- JSON object with additional details
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Task progress log (for progress updates during task execution)
CREATE TABLE IF NOT EXISTS task_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    percent_complete INTEGER CHECK (percent_complete IS NULL OR (percent_complete >= 0 AND percent_complete <= 100)),
    details TEXT, -- JSON object with additional details
    created_at TEXT DEFAULT (datetime('now'))
);

-- Users table (for admin UI authentication)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'reviewer' CHECK (role IN ('admin', 'reviewer', 'viewer')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    force_password_change INTEGER DEFAULT 0 CHECK (force_password_change IN (0, 1)),
    last_login_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Sessions table (for user sessions)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- User API keys table (for personal MCP access)
CREATE TABLE IF NOT EXISTS user_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL, -- First 15 chars (cav_uk_ + 8)
    name TEXT, -- Optional key name for identification
    last_used_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Comments table (for task and deliverable discussions)
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    -- Polymorphic association
    commentable_type TEXT NOT NULL CHECK (commentable_type IN ('task', 'deliverable')),
    commentable_id INTEGER NOT NULL,
    -- Author (can be user or agent)
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    -- Metadata
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Routes table (for delivery routing to external systems)
CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, -- NULL = global route (fires for system-level events across all projects)
    name TEXT NOT NULL,
    description TEXT,
    trigger_event TEXT NOT NULL, -- deliverable.approved, deliverable.submitted, task.created, etc.
    trigger_conditions TEXT, -- JSON: optional filters (tags, metadata)
    destination_type TEXT NOT NULL, -- webhook, email (Cloud adds: slack, wordpress, zapier)
    destination_config TEXT NOT NULL, -- JSON: destination-specific configuration
    field_mapping TEXT, -- JSON: maps deliverable fields to destination fields
    retry_policy TEXT DEFAULT '{"max_retries": 3, "backoff_type": "exponential", "initial_delay_ms": 1000}',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Delivery logs table (tracks route execution history)
CREATE TABLE IF NOT EXISTS delivery_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL, -- Direct deliverable link
    event_type TEXT NOT NULL,
    event_payload TEXT NOT NULL, -- JSON: snapshot of event data
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
    attempt_number INTEGER DEFAULT 1,
    response_status INTEGER, -- HTTP status code
    response_body TEXT, -- Truncated response (max 50KB)
    error_message TEXT,
    dispatched_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    duration_ms INTEGER,
    next_retry_at TEXT  -- When to attempt next retry (NULL if not retrying)
);

-- Universal activity log (tracks lifecycle events on deliverables and tasks)
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,        -- 'deliverable' or 'task'
    entity_id INTEGER NOT NULL,       -- deliverable.id or tasks.id
    event_type TEXT NOT NULL,         -- e.g. 'status_changed', 'created', 'assigned'
    actor_name TEXT,                  -- user name, agent name, or 'system'
    detail TEXT,                      -- JSON context
    created_at TEXT DEFAULT (datetime('now'))
);

-- Stored storage connections (reusable S3 credentials)
CREATE TABLE IF NOT EXISTS storage_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 's3',
    bucket TEXT NOT NULL,
    region TEXT DEFAULT 'us-east-1',
    endpoint TEXT,
    access_key_id_encrypted TEXT NOT NULL,
    access_key_id_iv TEXT NOT NULL,
    access_key_id_key_version INTEGER DEFAULT NULL, -- Keyring version used for access_key_id
    access_key_id_preview TEXT NOT NULL,  -- Last 4 chars for display: "...ABCD"
    secret_access_key_encrypted TEXT NOT NULL,
    secret_access_key_iv TEXT NOT NULL,
    secret_access_key_key_version INTEGER DEFAULT NULL, -- Keyring version used for secret_access_key
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance
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

-- Additional indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_status ON webhooks(status);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_deliverables_parent ON deliverables(parent_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);

-- Route indexes
CREATE INDEX IF NOT EXISTS idx_routes_project ON routes(project_id);
CREATE INDEX IF NOT EXISTS idx_routes_trigger ON routes(project_id, trigger_event);
CREATE INDEX IF NOT EXISTS idx_routes_enabled ON routes(project_id, trigger_event, enabled);
CREATE INDEX IF NOT EXISTS idx_routes_global_trigger ON routes(trigger_event) WHERE project_id IS NULL;

-- Delivery log indexes
CREATE INDEX IF NOT EXISTS idx_delivery_logs_route ON delivery_logs(route_id, dispatched_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_status ON delivery_logs(status);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_deliverable ON delivery_logs(deliverable_id);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_retry ON delivery_logs(status, next_retry_at);

-- Activity log indexes
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

-- Agent profile indexes
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agents_capacity ON agents(active_task_count, max_concurrent_tasks);

-- Task routing indexes
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks(tags);
CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_preferred_agent ON tasks(preferred_agent_id);
CREATE INDEX IF NOT EXISTS idx_projects_default_agent ON projects(default_agent_id);

-- Agent routing indexes
CREATE INDEX IF NOT EXISTS idx_agents_agent_type ON agents(agent_type);
CREATE INDEX IF NOT EXISTS idx_agents_specialization ON agents(specialization);

-- Storage connection indexes
CREATE INDEX IF NOT EXISTS idx_storage_connections_name ON storage_connections(name);
