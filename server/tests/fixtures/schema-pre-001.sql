-- Pre-migration-001 schema fixture
-- This is schema.sql WITHOUT the encryption_key_version columns
-- that migration 001_encryption_key_versions.sql adds.
-- Used to test the upgrade path from older installations.

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
    task_routing_rules TEXT,
    default_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    -- NOTE: encryption_key_version intentionally MISSING (added by migration 001)
    provider_model TEXT,
    system_prompt TEXT,
    execution_mode TEXT DEFAULT 'manual' CHECK (execution_mode IN ('manual', 'auto', 'polling', 'human')),
    max_tokens INTEGER DEFAULT 4096,
    temperature REAL DEFAULT 0.7,
    agent_type TEXT DEFAULT 'general',
    specialization TEXT,
    project_access TEXT DEFAULT '["*"]',
    task_types TEXT DEFAULT '["*"]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT,
    scopes TEXT DEFAULT '["read","write"]',
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
    assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'review', 'completed', 'cancelled')),
    priority INTEGER DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
    context TEXT,
    due_date TEXT,
    assigned_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    routing_rule_id TEXT,
    routing_decision TEXT,
    task_type TEXT,
    required_capabilities TEXT,
    preferred_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliverables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    reviewed_at TEXT,
    feedback TEXT,
    metadata TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    provider TEXT,
    model TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT DEFAULT 'markdown' CHECK (content_type IN ('markdown', 'html', 'json', 'text')),
    category TEXT,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER REFERENCES webhooks(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    response_status INTEGER,
    response_body TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id INTEGER,
    details TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    percent_complete INTEGER CHECK (percent_complete IS NULL OR (percent_complete >= 0 AND percent_complete <= 100)),
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT,
    last_used_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    commentable_type TEXT NOT NULL CHECK (commentable_type IN ('task', 'deliverable')),
    commentable_id INTEGER NOT NULL,
    author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS delivery_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    event_payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
    attempt_number INTEGER DEFAULT 1,
    response_status INTEGER,
    response_body TEXT,
    error_message TEXT,
    dispatched_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    duration_ms INTEGER,
    next_retry_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor_name TEXT,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS storage_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 's3',
    bucket TEXT NOT NULL,
    region TEXT DEFAULT 'us-east-1',
    endpoint TEXT,
    access_key_id_encrypted TEXT NOT NULL,
    access_key_id_iv TEXT NOT NULL,
    -- NOTE: access_key_id_key_version intentionally MISSING (added by migration 001)
    access_key_id_preview TEXT NOT NULL,
    secret_access_key_encrypted TEXT NOT NULL,
    secret_access_key_iv TEXT NOT NULL,
    -- NOTE: secret_access_key_key_version intentionally MISSING (added by migration 001)
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
