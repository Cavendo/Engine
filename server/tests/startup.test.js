import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { createSqliteAdapter } from '../db/sqliteAdapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Point DATABASE_PATH to a temp file so init.js doesn't touch real data
const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-startup-'));
const freshDbPath = join(tempDir, 'fresh.db');
const upgradeDbPath = join(tempDir, 'upgrade.db');
process.env.DATABASE_PATH = freshDbPath;
process.env.SESSION_SECRET = 'test-secret-for-startup-smoke-test';

// Stub bcrypt so we don't need native bindings in CI
const FAKE_HASH = '$2b$10$fakehashfortest';
jest.unstable_mockModule('bcrypt', () => ({
  default: { hash: async () => FAKE_HASH, compare: async () => false },
  hash: async () => FAKE_HASH,
  compare: async () => false,
}));

const { initializeDatabase } = await import('../db/init.js');
const { runMigrations } = await import('../db/migrator.js');
const { runCryptoHealthCheck } = await import('../utils/crypto.js');

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Startup sequence (fresh install)', () => {
  test('initializeDatabase → runMigrations → runCryptoHealthCheck succeeds on empty DB', async () => {
    const db = new Database(freshDbPath);
    db.pragma('foreign_keys = ON');
    const adapter = createSqliteAdapter(db);

    // Step 1: Initialize schema + seed data
    await initializeDatabase(adapter);

    // Verify core tables exist
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map(r => r.name);
    expect(tables).toContain('agents');
    expect(tables).toContain('tasks');
    expect(tables).toContain('deliverables');

    // Step 2: Run migrations (should handle "duplicate column" gracefully)
    await runMigrations(adapter);

    // Verify schema_migrations table exists and migration 001 is marked applied
    const migrations = db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version);
    expect(migrations).toContain('001_encryption_key_versions');

    // Step 3: Crypto health check
    const health = await runCryptoHealthCheck(adapter);
    expect(health.ok).toBe(true);

    db.close();
  });
});

describe('Startup sequence (upgrade from pre-001 schema)', () => {
  test('migration 001 adds key_version columns to existing tables', async () => {
    // Simulate an old database: create tables from pre-migration-001 fixture
    const db = new Database(upgradeDbPath);
    db.pragma('foreign_keys = ON');
    const adapter = createSqliteAdapter(db);

    const oldSchema = readFileSync(join(__dirname, 'fixtures/schema-pre-001.sql'), 'utf-8');
    db.exec(oldSchema);

    // Verify the key_version columns do NOT exist yet
    const agentCols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
    expect(agentCols).not.toContain('encryption_key_version');

    const connCols = db.prepare('PRAGMA table_info(storage_connections)').all().map(c => c.name);
    expect(connCols).not.toContain('access_key_id_key_version');
    expect(connCols).not.toContain('secret_access_key_key_version');

    // Insert a plain agent (no encrypted key) to verify table is populated
    db.prepare(`
      INSERT INTO agents (name, type) VALUES ('test-agent', 'autonomous')
    `).run();

    // Now run initializeDatabase (idempotent CREATE TABLE IF NOT EXISTS)
    // Point DATABASE_PATH so init.js logs the right path
    process.env.DATABASE_PATH = upgradeDbPath;
    await initializeDatabase(adapter);

    // Run migrations — 001 should ADD the columns and backfill
    await runMigrations(adapter);

    // Verify columns were added
    const agentColsAfter = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
    expect(agentColsAfter).toContain('encryption_key_version');

    const connColsAfter = db.prepare('PRAGMA table_info(storage_connections)').all().map(c => c.name);
    expect(connColsAfter).toContain('access_key_id_key_version');
    expect(connColsAfter).toContain('secret_access_key_key_version');

    // Verify pre-existing agent still has NULL version (no encrypted key to backfill)
    const agent = db.prepare('SELECT encryption_key_version FROM agents WHERE name = ?').get('test-agent');
    expect(agent.encryption_key_version).toBeNull();

    // Verify migration is recorded
    const migrations = db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version);
    expect(migrations).toContain('001_encryption_key_versions');

    // Crypto health check should pass
    const health = await runCryptoHealthCheck(adapter);
    expect(health.ok).toBe(true);

    db.close();
  });
});
