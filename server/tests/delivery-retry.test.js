/**
 * Smoke test: Fresh DB baseline + delivery route retry flow
 *
 * Creates an in-memory SQLite database from schema.sql,
 * inserts a route and a failed delivery log with retrying status,
 * and verifies the retry sweep query finds it correctly.
 *
 * This validates:
 *  1. schema.sql creates all tables without error (fresh-install baseline)
 *  2. delivery_logs.next_retry_at column exists and is queryable
 *  3. The retry sweep query matches due deliveries correctly
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Convert JS Date to SQLite datetime format (YYYY-MM-DD HH:MM:SS) */
function toSqliteDatetime(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

let db;

beforeAll(() => {
  // Create fresh in-memory database from schema.sql
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '../db/schema.sql'), 'utf-8');
  db.exec(schema);
});

afterAll(() => {
  db.close();
});

describe('Fresh DB baseline', () => {
  it('creates all expected tables from schema.sql', () => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(r => r.name);

    // Core tables that must exist
    const required = [
      'agents', 'agent_keys', 'tasks', 'deliverables', 'projects',
      'routes', 'delivery_logs', 'activity_log', 'users', 'sessions'
    ];

    for (const table of required) {
      expect(tables).toContain(table);
    }
  });

  it('delivery_logs has next_retry_at column', () => {
    const columns = db.prepare('PRAGMA table_info(delivery_logs)').all();
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('next_retry_at');
  });
});

describe('Delivery route retry flow', () => {
  let projectId;
  let routeId;

  beforeAll(() => {
    // Create a project
    const project = db.prepare(`
      INSERT INTO projects (name, description, status) VALUES ('Test Project', 'For testing', 'active')
    `).run();
    projectId = project.lastInsertRowid;

    // Create a route
    const route = db.prepare(`
      INSERT INTO routes (project_id, name, trigger_event, destination_type, destination_config, enabled)
      VALUES (?, 'Test Webhook', 'task.execution_failed', 'webhook', '{"url":"https://example.com/hook"}', 1)
    `).run(projectId);
    routeId = route.lastInsertRowid;
  });

  it('inserts a retrying delivery log with next_retry_at', () => {
    const pastTime = toSqliteDatetime(new Date(Date.now() - 60000)); // 1 minute ago

    db.prepare(`
      INSERT INTO delivery_logs (route_id, event_type, event_payload, status, next_retry_at)
      VALUES (?, 'task.execution_failed', '{"test":true}', 'retrying', ?)
    `).run(routeId, pastTime);

    const log = db.prepare('SELECT * FROM delivery_logs WHERE route_id = ?').get(routeId);
    expect(log).toBeTruthy();
    expect(log.status).toBe('retrying');
    expect(log.next_retry_at).toBe(pastTime);
  });

  it('retry sweep query finds due deliveries', () => {
    // This mirrors the actual query from routeDispatcher.js retrySweep()
    const due = db.prepare(`
      SELECT dl.*, r.trigger_event, r.destination_type, r.destination_config,
             r.field_mapping, r.retry_policy, r.name as route_name, r.enabled,
             r.trigger_conditions, r.project_id as route_project_id
      FROM delivery_logs dl
      JOIN routes r ON r.id = dl.route_id
      WHERE dl.status = 'retrying'
        AND dl.next_retry_at <= datetime('now')
      ORDER BY dl.next_retry_at ASC
      LIMIT 10
    `).all();

    expect(due.length).toBe(1);
    expect(due[0].route_name).toBe('Test Webhook');
    expect(due[0].event_type).toBe('task.execution_failed');
    expect(due[0].route_project_id).toBe(projectId);
  });

  it('does not find deliveries scheduled for the future', () => {
    const futureTime = toSqliteDatetime(new Date(Date.now() + 3600000)); // 1 hour from now

    db.prepare(`
      INSERT INTO delivery_logs (route_id, event_type, event_payload, status, next_retry_at)
      VALUES (?, 'task.execution_failed', '{"future":true}', 'retrying', ?)
    `).run(routeId, futureTime);

    const due = db.prepare(`
      SELECT * FROM delivery_logs
      WHERE status = 'retrying' AND next_retry_at <= datetime('now')
    `).all();

    // Should still only find the one from the previous test (past time)
    expect(due.length).toBe(1);
  });

  it('does not find delivered or failed logs', () => {
    db.prepare(`
      INSERT INTO delivery_logs (route_id, event_type, event_payload, status, next_retry_at)
      VALUES (?, 'task.execution_failed', '{"done":true}', 'delivered', ?)
    `).run(routeId, toSqliteDatetime(new Date(Date.now() - 60000)));

    db.prepare(`
      INSERT INTO delivery_logs (route_id, event_type, event_payload, status, next_retry_at)
      VALUES (?, 'task.execution_failed', '{"failed":true}', 'failed', ?)
    `).run(routeId, toSqliteDatetime(new Date(Date.now() - 60000)));

    const due = db.prepare(`
      SELECT * FROM delivery_logs
      WHERE status = 'retrying' AND next_retry_at <= datetime('now')
    `).all();

    // Still only the original past-time retrying log
    expect(due.length).toBe(1);
  });
});
