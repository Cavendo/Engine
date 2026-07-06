import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { createSqliteAdapter } from '../db/sqliteAdapter.js';
import { runMigrations } from '../db/migrator.js';

const fixturePath = join(
  fileURLToPath(new URL('fixtures/schema-pre-001.sql', import.meta.url))
);

function countRows(raw, table) {
  return raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function tableColumns(raw, table) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

describe('SQLite rebuild migrations', () => {
  test('preserve dependent rows while rebuilding users and tasks tables', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(readFileSync(fixturePath, 'utf8'));

    const userId = Number(raw.prepare(`
      INSERT INTO users (email, password_hash, name, role, status)
      VALUES ('owner@test.local', 'hash', 'Owner', 'admin', 'active')
    `).run().lastInsertRowid);
    raw.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES ('session-before-rebuild', ?, datetime('now', '+1 hour'))
    `).run(userId);
    raw.prepare(`
      INSERT INTO user_keys (user_id, key_hash, key_prefix, name)
      VALUES (?, 'hash-before-rebuild', 'cav_uk_pre', 'Pre rebuild user key')
    `).run(userId);

    const projectId = Number(raw.prepare(`
      INSERT INTO projects (name, description, status)
      VALUES ('Migration Project', 'Upgrade regression fixture', 'active')
    `).run().lastInsertRowid);
    const agentId = Number(raw.prepare(`
      INSERT INTO agents (name, type, status, execution_mode)
      VALUES ('Migration Agent', 'supervised', 'active', 'manual')
    `).run().lastInsertRowid);
    const taskId = Number(raw.prepare(`
      INSERT INTO tasks (project_id, assigned_agent_id, title, description, status, priority, tags, context)
      VALUES (?, ?, 'Migration Task', 'Should survive task table rebuilds', 'assigned', 2, '[]', '{}')
    `).run(projectId, agentId).lastInsertRowid);

    raw.prepare(`
      INSERT INTO deliverables (task_id, project_id, agent_id, title, summary, content, status, version)
      VALUES (?, ?, ?, 'Migration Deliverable', 'Summary', 'Content', 'pending', 1)
    `).run(taskId, projectId, agentId);
    raw.prepare(`
      INSERT INTO task_progress (task_id, agent_id, message, percent_complete, details)
      VALUES (?, ?, 'Started', 10, '{}')
    `).run(taskId, agentId);
    raw.prepare(`
      INSERT INTO comments (content, commentable_type, commentable_id, author_type, author_id, author_name)
      VALUES ('Still here', 'task', ?, 'user', ?, 'Owner')
    `).run(taskId, userId);
    raw.prepare(`
      INSERT INTO activity_log (entity_type, entity_id, event_type, actor_name, detail)
      VALUES ('task', ?, 'created', 'Owner', '{}')
    `).run(taskId);

    const db = createSqliteAdapter(raw);
    await runMigrations(db);

    expect(countRows(raw, 'users')).toBe(1);
    expect(countRows(raw, 'sessions')).toBe(1);
    expect(countRows(raw, 'user_keys')).toBe(1);
    expect(countRows(raw, 'tasks')).toBe(1);
    expect(countRows(raw, 'deliverables')).toBe(1);
    expect(countRows(raw, 'task_progress')).toBe(1);
    expect(countRows(raw, 'comments')).toBe(1);
    expect(countRows(raw, 'activity_log')).toBe(1);
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    raw.prepare("UPDATE tasks SET status = 'blocked', external_execution_status = 'completed' WHERE id = ?")
      .run(taskId);
    expect(raw.prepare('SELECT status, external_execution_status FROM tasks WHERE id = ?').get(taskId))
      .toEqual({ status: 'blocked', external_execution_status: 'completed' });

    raw.close();
  });

  test('adds project_access to older agents tables that predate project scoping', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        execution_mode TEXT DEFAULT 'manual'
      );
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      );
    `);

    for (const version of [
      '001_encryption_key_versions',
      '002_deliverables_task_version_index',
      '003_deliverables_task_version_unique',
      '004_agent_provider_endpoint',
      '005_due_date_timestamptz',
      '006_runtime_skills',
      '006_task_status_blocked_deferred',
      '007_projects_external_key',
      '007_session_security',
      '008_user_operator_role',
      '009_runtime_skills_operator_policy',
      '010_external_agent_task_leases',
      '011_agent_users',
      '012_external_task_completed_status',
      '013_project_primary_url',
      '014_task_creator_tracking',
    ]) {
      raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    }

    const agentId = Number(raw.prepare(`
      INSERT INTO agents (name, type, status, execution_mode)
      VALUES ('Legacy Agent', 'supervised', 'active', 'manual')
    `).run().lastInsertRowid);

    expect(tableColumns(raw, 'agents')).not.toContain('project_access');

    const db = createSqliteAdapter(raw);
    await runMigrations(db);

    expect(tableColumns(raw, 'agents')).toContain('project_access');
    expect(raw.prepare('SELECT project_access FROM agents WHERE id = ?').get(agentId))
      .toEqual({ project_access: '["*"]' });

    raw.close();
  });
});
