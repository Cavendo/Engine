-- Allow blocked/deferred in tasks.status check constraint (SQLite).
-- SQLite cannot ALTER a CHECK directly, so rebuild the table safely.

CREATE TABLE tasks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
    assigned_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'review', 'blocked', 'deferred', 'completed', 'cancelled')),
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

INSERT INTO tasks_new (
    id, project_id, sprint_id, assigned_agent_id, title, description, tags, status, priority, context,
    due_date, assigned_at, started_at, completed_at, routing_rule_id, routing_decision, task_type,
    required_capabilities, preferred_agent_id, created_at, updated_at
)
SELECT
    id, project_id, sprint_id, assigned_agent_id, title, description, tags, status, priority, context,
    due_date, assigned_at, started_at, completed_at, routing_rule_id, routing_decision, task_type,
    required_capabilities, preferred_agent_id, created_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_status ON tasks(priority, status);
CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);
CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks(tags);
CREATE INDEX IF NOT EXISTS idx_tasks_task_type ON tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_preferred_agent ON tasks(preferred_agent_id);
