import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

// Point DATABASE_PATH to a temp file so init.js doesn't touch real data
const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-startup-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
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
    const db = new Database(tempDbPath);
    db.pragma('foreign_keys = ON');

    // Step 1: Initialize schema + seed data
    await initializeDatabase(db);

    // Verify core tables exist
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map(r => r.name);
    expect(tables).toContain('agents');
    expect(tables).toContain('tasks');
    expect(tables).toContain('deliverables');

    // Step 2: Run migrations (should handle "duplicate column" gracefully)
    expect(() => runMigrations(db)).not.toThrow();

    // Verify schema_migrations table exists and migration 001 is marked applied
    const migrations = db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version);
    expect(migrations).toContain('001_encryption_key_versions');

    // Step 3: Crypto health check
    const health = runCryptoHealthCheck(db);
    expect(health.ok).toBe(true);

    db.close();
  });
});
