import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { createSqliteAdapter } from '../db/sqliteAdapter.js';

// Temp DB setup
const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-agent-create-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.SESSION_SECRET = 'test-secret-for-agent-create-test';

// Stub bcrypt
const FAKE_HASH = '$2b$10$fakehashfortest';
jest.unstable_mockModule('bcrypt', () => ({
  default: { hash: async () => FAKE_HASH, compare: async () => false },
  hash: async () => FAKE_HASH,
  compare: async () => false,
}));

const { initializeDatabase } = await import('../db/init.js');
const { runMigrations } = await import('../db/migrator.js');
const { encrypt, decrypt } = await import('../utils/crypto.js');
const { createAgentSchema } = await import('../utils/validation.js');

let db;
let adapter;

beforeAll(async () => {
  db = new Database(tempDbPath);
  db.pragma('foreign_keys = ON');
  adapter = createSqliteAdapter(db);
  await initializeDatabase(adapter);
  await runMigrations(adapter);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createAgentSchema validation', () => {
  test('accepts camelCase execution fields', () => {
    const result = createAgentSchema.safeParse({
      name: 'Test Agent',
      type: 'autonomous',
      provider: 'anthropic',
      providerApiKey: 'sk-ant-test-key',
      providerModel: 'claude-sonnet-4-20250514',
      executionMode: 'auto',
      maxTokens: 2000,
    });
    expect(result.success).toBe(true);
    expect(result.data.provider).toBe('anthropic');
    expect(result.data.providerApiKey).toBe('sk-ant-test-key');
    expect(result.data.providerModel).toBe('claude-sonnet-4-20250514');
    expect(result.data.executionMode).toBe('auto');
    expect(result.data.maxTokens).toBe(2000);
  });

  test('normalizes snake_case aliases to camelCase', () => {
    const result = createAgentSchema.safeParse({
      name: 'Test Agent',
      type: 'autonomous',
      provider: 'anthropic',
      provider_api_key: 'sk-ant-test-key',
      provider_model: 'claude-sonnet-4-20250514',
      execution_mode: 'auto',
      max_tokens: 2000,
    });
    expect(result.success).toBe(true);
    expect(result.data.providerApiKey).toBe('sk-ant-test-key');
    expect(result.data.providerModel).toBe('claude-sonnet-4-20250514');
    expect(result.data.executionMode).toBe('auto');
    expect(result.data.maxTokens).toBe(2000);
  });

  test('normalizes "model" shorthand to providerModel', () => {
    const result = createAgentSchema.safeParse({
      name: 'Test Agent',
      type: 'autonomous',
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
    });
    expect(result.success).toBe(true);
    expect(result.data.providerModel).toBe('claude-3-5-haiku-20241022');
  });

  test('accepts metadata-only create (no execution fields)', () => {
    const result = createAgentSchema.safeParse({
      name: 'Simple Agent',
      type: 'supervised',
    });
    expect(result.success).toBe(true);
    expect(result.data.provider).toBeUndefined();
    expect(result.data.providerApiKey).toBeUndefined();
  });
});

describe('One-step agent create with execution config', () => {
  test('INSERT with execution fields persists provider, model, and encrypted key', () => {
    const apiKey = 'sk-ant-api03-test-key-12345';
    const { encrypted, iv, keyVersion } = encrypt(apiKey);

    const result = db.prepare(`
      INSERT INTO agents (
        name, type, provider, provider_api_key_encrypted, provider_api_key_iv,
        encryption_key_version, provider_model, execution_mode, max_tokens, temperature
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'One-Step Agent', 'autonomous', 'anthropic',
      encrypted, iv, keyVersion,
      'claude-sonnet-4-20250514', 'auto', 2000, 0.5
    );

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(result.lastInsertRowid);

    expect(agent.provider).toBe('anthropic');
    expect(agent.provider_model).toBe('claude-sonnet-4-20250514');
    expect(agent.provider_api_key_encrypted).not.toBeNull();
    expect(agent.encryption_key_version).toBe(keyVersion);
    expect(agent.execution_mode).toBe('auto');
    expect(agent.max_tokens).toBe(2000);
    expect(agent.temperature).toBe(0.5);

    // Verify decryption round-trip
    const decrypted = decrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv, agent.encryption_key_version);
    expect(decrypted).toBe(apiKey);
  });

  test('metadata-only create leaves execution fields NULL', () => {
    const result = db.prepare(`
      INSERT INTO agents (name, type) VALUES (?, ?)
    `).run('Metadata-Only Agent', 'supervised');

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(result.lastInsertRowid);

    expect(agent.provider).toBeNull();
    expect(agent.provider_api_key_encrypted).toBeNull();
    expect(agent.provider_model).toBeNull();
    expect(agent.encryption_key_version).toBeNull();
  });
});
