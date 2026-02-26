/**
 * Tests for Issues #15 and #18
 * #15: Deliverable version races — unique (task_id, version) constraint + retry
 * #18: Capacity oversubscription — atomic reserveAgentCapacity()
 *
 * All contention is simulated deterministically via sequential interleaved calls
 * and forced constraint violations. No real parallel write timing — SQLite serializes writes.
 *
 * These tests import production functions directly (with _db override) so that
 * any drift in production SQL is caught immediately.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { insertDeliverableWithRetry } from '../utils/deliverableVersioning.js';
import {
  reserveAgentCapacity,
  decrementActiveTaskCount,
  incrementActiveTaskCount
} from '../services/taskRouter.js';
import { createSqliteAdapter } from '../db/sqliteAdapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'db', 'schema.sql');

function createTestDb() {
  const raw = Database(':memory:');
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  const schema = readFileSync(schemaPath, 'utf-8');
  raw.exec(schema);
  const adapter = createSqliteAdapter(raw);
  return { raw, adapter };
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
  return Number(result.lastInsertRowid);
}

function seedTask(db, agentId, status = 'pending') {
  const result = db.prepare(`
    INSERT INTO tasks (title, assigned_agent_id, status) VALUES (?, ?, ?)
  `).run('Test Task', agentId, status);
  return Number(result.lastInsertRowid);
}

function seedDeliverable(db, taskId, version, agentId = null) {
  const result = db.prepare(`
    INSERT INTO deliverables (task_id, agent_id, title, content, version, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(taskId, agentId, `Deliverable v${version}`, 'content', version);
  return Number(result.lastInsertRowid);
}

// ============================================
// Issue #15: Deliverable Version Races
// ============================================

describe('Issue #15: Deliverable version uniqueness', () => {
  let db;
  let adapter;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.raw;
    adapter = testDb.adapter;
  });

  afterEach(() => {
    db.close();
  });

  test('unique index exists and blocks duplicate (task_id, version) INSERT', () => {
    const agentId = seedAgent(db);
    const taskId = seedTask(db, agentId);
    seedDeliverable(db, taskId, 1, agentId);

    // Inserting same (task_id, version) should throw
    expect(() => {
      seedDeliverable(db, taskId, 1, agentId);
    }).toThrow();
  });

  test('two deliverable inserts for same task get unique versions via MAX(version)', () => {
    const agentId = seedAgent(db);
    const taskId = seedTask(db, agentId);

    // Simulate two sequential inserts both using MAX(version) pattern
    const insert = () => {
      const lastVersion = db.prepare(
        'SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?'
      ).get(taskId);
      const version = (lastVersion?.max_version || 0) + 1;
      return seedDeliverable(db, taskId, version, agentId);
    };

    const id1 = insert();
    const id2 = insert();

    const d1 = db.prepare('SELECT version FROM deliverables WHERE id = ?').get(id1);
    const d2 = db.prepare('SELECT version FROM deliverables WHERE id = ?').get(id2);

    expect(d1.version).toBe(1);
    expect(d2.version).toBe(2);
    expect(id1).not.toBe(id2);
  });

  test('retry succeeds after one forced unique conflict (production insertDeliverableWithRetry)', async () => {
    const agentId = seedAgent(db);
    const taskId = seedTask(db, agentId);
    seedDeliverable(db, taskId, 1, agentId);

    let callCount = 0;
    const result = await insertDeliverableWithRetry(adapter, async (tx) => {
      callCount++;
      if (callCount === 1) {
        // First attempt: force conflict by trying version 1 (already exists)
        const r = db.prepare(`
          INSERT INTO deliverables (task_id, agent_id, title, content, version, status)
          VALUES (?, ?, ?, ?, ?, 'pending')
        `).run(taskId, agentId, 'Retry test', 'content', 1);
        return Number(r.lastInsertRowid);
      }
      // Subsequent attempts: read MAX and use correct version
      const lastVersion = db.prepare(
        'SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?'
      ).get(taskId);
      const version = (lastVersion?.max_version || 0) + 1;
      const r = db.prepare(`
        INSERT INTO deliverables (task_id, agent_id, title, content, version, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(taskId, agentId, 'Retry test', 'content', version);
      return Number(r.lastInsertRowid);
    });

    expect(callCount).toBe(2); // First attempt failed, second succeeded
    const d = db.prepare('SELECT version FROM deliverables WHERE id = ?').get(result);
    expect(d.version).toBe(2);
  });

  test('standalone deliverables (task_id IS NULL) unaffected by unique index', () => {
    // Multiple deliverables with NULL task_id and same version should be allowed
    db.prepare(`
      INSERT INTO deliverables (task_id, title, content, version, status)
      VALUES (NULL, 'Standalone 1', 'content', 1, 'pending')
    `).run();

    expect(() => {
      db.prepare(`
        INSERT INTO deliverables (task_id, title, content, version, status)
        VALUES (NULL, 'Standalone 2', 'content', 1, 'pending')
      `).run();
    }).not.toThrow();

    const count = db.prepare(
      'SELECT COUNT(*) as count FROM deliverables WHERE task_id IS NULL AND version = 1'
    ).get();
    expect(count.count).toBe(2);
  });

  test('revision path allocates correct version via MAX(version) (production insertDeliverableWithRetry)', async () => {
    const agentId = seedAgent(db);
    const taskId = seedTask(db, agentId);
    const d1Id = seedDeliverable(db, taskId, 1, agentId);
    seedDeliverable(db, taskId, 2, agentId);

    // Simulate revision: should get version 3 via MAX(version), not parent.version + 1
    const result = await insertDeliverableWithRetry(adapter, async (tx) => {
      const lastVersion = db.prepare(
        'SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?'
      ).get(taskId);
      const version = (lastVersion?.max_version || 0) + 1;
      const r = db.prepare(`
        INSERT INTO deliverables (task_id, agent_id, title, content, version, parent_id, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(taskId, agentId, 'Revision', 'revised content', version, d1Id);
      return { id: Number(r.lastInsertRowid), version };
    });

    expect(result.version).toBe(3);
  });

  test('retry exhaustion throws after max retries (production insertDeliverableWithRetry)', async () => {
    const agentId = seedAgent(db);
    const taskId = seedTask(db, agentId);
    seedDeliverable(db, taskId, 1, agentId);

    // Always try to insert version 1 — should exhaust retries
    let threw = false;
    try {
      await insertDeliverableWithRetry(adapter, async (tx) => {
        db.prepare(`
          INSERT INTO deliverables (task_id, agent_id, title, content, version, status)
          VALUES (?, ?, ?, ?, ?, 'pending')
        `).run(taskId, agentId, 'Conflict', 'content', 1);
      });
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ============================================
// Issue #18: Capacity Oversubscription
// ============================================

describe('Issue #18: Atomic capacity reservation', () => {
  let db;
  let adapter;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.raw;
    adapter = testDb.adapter;
  });

  afterEach(() => {
    db.close();
  });

  test('reserveAgentCapacity succeeds when capacity available (production fn)', async () => {
    const agentId = seedAgent(db, { max_concurrent_tasks: 5, active_task_count: 2 });
    const result = await reserveAgentCapacity(agentId, adapter);
    expect(result.ok).toBe(true);

    const agent = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    expect(agent.active_task_count).toBe(3);
  });

  test('reserveAgentCapacity fails when at max capacity (production fn)', async () => {
    const agentId = seedAgent(db, { max_concurrent_tasks: 3, active_task_count: 3 });
    const result = await reserveAgentCapacity(agentId, adapter);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('At capacity');

    const agent = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    expect(agent.active_task_count).toBe(3); // unchanged
  });

  test('reserveAgentCapacity fails for non-active agent (production fn)', async () => {
    const agentId = seedAgent(db, { status: 'paused', max_concurrent_tasks: 5, active_task_count: 0 });
    const result = await reserveAgentCapacity(agentId, adapter);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('paused');
  });

  test('reserveAgentCapacity treats NULL active_task_count as 0 (production fn)', async () => {
    const result = db.prepare(`
      INSERT INTO agents (name, type, capabilities, status, max_concurrent_tasks, active_task_count)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run('NULL Count Agent', 'autonomous', '["test"]', 'active', 5);
    const agentId = Number(result.lastInsertRowid);

    const reservation = await reserveAgentCapacity(agentId, adapter);
    expect(reservation.ok).toBe(true);

    const agent = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    expect(agent.active_task_count).toBe(1);
  });

  test('simulated contention: fill to 1 slot left, two sequential reservations — exactly one succeeds', async () => {
    const agentId = seedAgent(db, { max_concurrent_tasks: 3, active_task_count: 2 });

    const r1 = await reserveAgentCapacity(agentId, adapter);
    const r2 = await reserveAgentCapacity(agentId, adapter);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);

    const agent = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    expect(agent.active_task_count).toBe(3); // capped at max
  });

  test('after failed reservation, active_task_count unchanged', async () => {
    const agentId = seedAgent(db, { max_concurrent_tasks: 2, active_task_count: 2 });

    const before = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    await reserveAgentCapacity(agentId, adapter); // should fail
    const after = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);

    expect(after.active_task_count).toBe(before.active_task_count);
  });

  test('count consistency: reserve + release returns to original count (production fns)', async () => {
    const agentId = seedAgent(db, { max_concurrent_tasks: 5, active_task_count: 2 });

    await reserveAgentCapacity(agentId, adapter);
    const afterReserve = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    expect(afterReserve.active_task_count).toBe(3);

    await decrementActiveTaskCount(agentId, adapter);
    const afterRelease = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    expect(afterRelease.active_task_count).toBe(2);
  });

  test('no count leak on task write failure: transaction rolls back reservation (production fn)', async () => {
    const agentId = seedAgent(db, { max_concurrent_tasks: 5, active_task_count: 1 });

    const beforeCount = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId).active_task_count;

    // Simulate: reserve + task INSERT that fails (violate NOT NULL on title)
    let threw = false;
    try {
      await adapter.tx(async (tx) => {
        const reservation = await reserveAgentCapacity(agentId, adapter);
        expect(reservation.ok).toBe(true);

        // Force task INSERT to fail
        db.prepare(`
          INSERT INTO tasks (title, assigned_agent_id, status) VALUES (NULL, ?, 'assigned')
        `).run(agentId);
      });
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(true);

    // Reservation should be rolled back
    const afterCount = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId).active_task_count;
    expect(afterCount).toBe(beforeCount);
  });

  test('direct (manual) assignment bypasses capacity check (production incrementActiveTaskCount)', async () => {
    const agentId = seedAgent(db, { max_concurrent_tasks: 2, active_task_count: 2 });

    // Direct assignment uses incrementActiveTaskCount (unconditional)
    await incrementActiveTaskCount(agentId, adapter);

    const agent = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    expect(agent.active_task_count).toBe(3); // exceeds max — that's intentional for admin override
  });

  test('reserveAgentCapacity with NULL max_concurrent_tasks always succeeds (production fn)', async () => {
    // NULL max = unlimited capacity
    const result = db.prepare(`
      INSERT INTO agents (name, type, capabilities, status, max_concurrent_tasks, active_task_count)
      VALUES (?, ?, ?, ?, NULL, 100)
    `).run('Unlimited Agent', 'autonomous', '["test"]', 'active');
    const agentId = Number(result.lastInsertRowid);

    const reservation = await reserveAgentCapacity(agentId, adapter);
    expect(reservation.ok).toBe(true);

    const agent = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentId);
    expect(agent.active_task_count).toBe(101);
  });

  test('reserveAgentCapacity fails for non-existent agent (production fn)', async () => {
    const result = await reserveAgentCapacity(99999, adapter);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Agent not found');
  });

  test('PATCH reassign fallback: old agent count decremented when new reservation fails', async () => {
    // Simulates: task assigned to Agent A, PATCH auto-assign tries Agent B (at capacity),
    // reservation fails → task becomes unassigned, Agent A count must still decrement.
    const agentA = seedAgent(db, { name: 'Agent A', max_concurrent_tasks: 5, active_task_count: 2 });
    const agentB = seedAgent(db, { name: 'Agent B', max_concurrent_tasks: 1, active_task_count: 1 }); // at capacity
    const taskId = seedTask(db, agentA, 'assigned');

    // Simulate the PATCH auto-assign transaction:
    // 1. Try to reserve Agent B — should fail (at capacity)
    // 2. Task becomes unassigned (assigned_agent_id = NULL)
    // 3. Agent A's count must still be decremented
    await adapter.tx(async (tx) => {
      const reservation = await reserveAgentCapacity(agentB, tx);
      expect(reservation.ok).toBe(false);

      // Regardless of reservation outcome, old agent is released
      await decrementActiveTaskCount(agentA, tx);

      // Update task to unassigned
      await tx.exec('UPDATE tasks SET assigned_agent_id = NULL, status = ?, updated_at = datetime(\'now\') WHERE id = ?',
        ['pending', taskId]);
    });

    const agentAAfter = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentA);
    const agentBAfter = db.prepare('SELECT active_task_count FROM agents WHERE id = ?').get(agentB);
    const task = db.prepare('SELECT assigned_agent_id, status FROM tasks WHERE id = ?').get(taskId);

    expect(agentAAfter.active_task_count).toBe(1); // decremented from 2
    expect(agentBAfter.active_task_count).toBe(1); // unchanged (reservation failed)
    expect(task.assigned_agent_id).toBeNull();      // task unassigned
    expect(task.status).toBe('pending');
  });
});
