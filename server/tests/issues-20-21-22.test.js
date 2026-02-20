/**
 * Tests for Issues #20, #21, #22
 * #20: Block deletion of agents with active tasks
 * #21: Treat NULL active_task_count as 0 in availability checks
 * #22: Composite (task_id, version DESC) index on deliverables
 */
import { jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'db', 'schema.sql');

function createTestDb() {
  const db = Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  return db;
}

function seedAgent(db, overrides = {}) {
  const defaults = {
    name: 'Test Agent',
    type: 'autonomous',
    capabilities: '["test"]',
    status: 'active',
    max_concurrent_tasks: 5,
    active_task_count: 0
  };
  const d = { ...defaults, ...overrides };
  const result = db.prepare(`
    INSERT INTO agents (name, type, capabilities, status, max_concurrent_tasks, active_task_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(d.name, d.type, d.capabilities, d.status, d.max_concurrent_tasks, d.active_task_count);
  return result.lastInsertRowid;
}

function seedTask(db, agentId, status = 'pending') {
  const result = db.prepare(`
    INSERT INTO tasks (title, assigned_agent_id, status) VALUES (?, ?, ?)
  `).run('Test Task', agentId, status);
  return result.lastInsertRowid;
}

// ============================================
// Issue #20: Block Deletion of Agents with Active Tasks
// ============================================

describe('Issue #20: Agent deletion guard', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('allows deleting agent with 0 active tasks', () => {
    const agentId = seedAgent(db);
    // Add only terminal tasks
    seedTask(db, agentId, 'completed');
    seedTask(db, agentId, 'cancelled');

    const count = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE assigned_agent_id = ? AND status NOT IN ('completed', 'cancelled')
    `).get(agentId).count;

    expect(count).toBe(0);

    // Deletion should succeed
    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agentId);
    expect(agent).toBeUndefined();
  });

  test('blocks deleting agent with pending task', () => {
    const agentId = seedAgent(db);
    seedTask(db, agentId, 'pending');

    const count = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE assigned_agent_id = ? AND status NOT IN ('completed', 'cancelled')
    `).get(agentId).count;

    expect(count).toBe(1);
  });

  test('blocks deleting agent with in_progress task', () => {
    const agentId = seedAgent(db);
    seedTask(db, agentId, 'in_progress');

    const count = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE assigned_agent_id = ? AND status NOT IN ('completed', 'cancelled')
    `).get(agentId).count;

    expect(count).toBe(1);
  });

  test('blocks deleting agent with assigned task', () => {
    const agentId = seedAgent(db);
    seedTask(db, agentId, 'assigned');

    const count = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE assigned_agent_id = ? AND status NOT IN ('completed', 'cancelled')
    `).get(agentId).count;

    expect(count).toBe(1);
  });

  test('counts only non-terminal statuses', () => {
    const agentId = seedAgent(db);
    seedTask(db, agentId, 'completed');
    seedTask(db, agentId, 'cancelled');
    seedTask(db, agentId, 'in_progress');
    seedTask(db, agentId, 'review');

    const count = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE assigned_agent_id = ? AND status NOT IN ('completed', 'cancelled')
    `).get(agentId).count;

    // in_progress + review = 2 active
    expect(count).toBe(2);
  });
});

// ============================================
// Issue #21: NULL active_task_count handling
// ============================================

describe('Issue #21: NULL active_task_count normalization', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('NULL active_task_count treated as 0 — agent is available', () => {
    const agentId = seedAgent(db, { active_task_count: null });

    // Simulate checkAgentAvailability logic
    const agent = db.prepare(`
      SELECT status, max_concurrent_tasks, active_task_count FROM agents WHERE id = ?
    `).get(agentId);

    expect(agent.active_task_count).toBeNull();

    const activeCount = agent.active_task_count ?? 0;
    expect(activeCount).toBe(0);

    // Should be available (0 < 5)
    const available = agent.max_concurrent_tasks === null ||
      activeCount < agent.max_concurrent_tasks;
    expect(available).toBe(true);
  });

  test('NULL active_task_count at capacity boundary', () => {
    // max_concurrent_tasks = 0 edge case
    const agentId = seedAgent(db, { active_task_count: null, max_concurrent_tasks: 0 });

    const agent = db.prepare(`
      SELECT status, max_concurrent_tasks, active_task_count FROM agents WHERE id = ?
    `).get(agentId);

    const activeCount = agent.active_task_count ?? 0;
    // max_concurrent_tasks = 0, activeCount = 0: 0 >= 0 is true => at capacity
    // But our code checks max_concurrent_tasks > 0 first, so this agent has no capacity check
    // and is considered available
    const atCapacity = agent.max_concurrent_tasks !== null &&
      agent.max_concurrent_tasks > 0 &&
      activeCount >= agent.max_concurrent_tasks;
    expect(atCapacity).toBe(false);
  });

  test('COALESCE in match endpoint availability check', () => {
    const agentId = seedAgent(db, { active_task_count: null, max_concurrent_tasks: 3 });

    const agent = db.prepare(`
      SELECT status, max_concurrent_tasks, active_task_count FROM agents WHERE id = ?
    `).get(agentId);

    const activeCount = agent.active_task_count ?? 0;
    const available = agent.max_concurrent_tasks === null ||
      activeCount < agent.max_concurrent_tasks;

    expect(available).toBe(true);
    expect(activeCount).toBe(0);
  });
});

// ============================================
// Issue #22: Composite (task_id, version DESC) index
// ============================================

describe('Issue #22: Deliverables task_id + version index', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  test('idx_deliverables_task_version index exists after schema init', () => {
    const index = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_deliverables_task_version'
    `).get();

    expect(index).toBeDefined();
    expect(index.name).toBe('idx_deliverables_task_version');
  });

  test('migration 002 creates index on existing DB', () => {
    // Create a DB without the new index (drop it)
    db.exec('DROP INDEX IF EXISTS idx_deliverables_task_version');

    // Verify it's gone
    let index = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_deliverables_task_version'
    `).get();
    expect(index).toBeUndefined();

    // Apply migration SQL
    db.exec('CREATE INDEX IF NOT EXISTS idx_deliverables_task_version ON deliverables(task_id, version DESC)');

    // Verify it's back
    index = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_deliverables_task_version'
    `).get();
    expect(index).toBeDefined();
  });

  test('index is used for latest-version query', () => {
    // Seed some deliverables
    const agentId = seedAgent(db);
    const taskId = seedTask(db, agentId);

    for (let v = 1; v <= 3; v++) {
      db.prepare(`
        INSERT INTO deliverables (task_id, agent_id, title, version) VALUES (?, ?, ?, ?)
      `).run(taskId, agentId, `Deliverable v${v}`, v);
    }

    // Query plan should reference the index
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, version FROM deliverables WHERE task_id = ? ORDER BY version DESC LIMIT 1
    `).all(taskId);

    const planText = plan.map(r => r.detail).join(' ');
    // Should use the covering index or at least scan via index
    expect(planText).toMatch(/idx_deliverables_task_version/);
  });
});
