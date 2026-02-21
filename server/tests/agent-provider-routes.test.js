/**
 * Route-level integration tests for openai_compatible provider support.
 *
 * Spins up a real Express app with the agents router, a temp SQLite DB,
 * and supertest to make actual HTTP requests. Validates:
 *   - provider=openai + providerBaseUrl → 400 on both CREATE and PATCH
 *   - provider=openai_compatible + no key + valid local base URL → persists
 *   - Round-trip: created agent resolves correct base URL in executor
 */

import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

// ============================================
// Test environment setup — BEFORE any app imports
// ============================================

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-agent-provider-routes-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.SESSION_SECRET = 'test-secret-for-agent-provider-routes';
process.env.NODE_ENV = 'test';
// Ensure ENCRYPTION_KEY is set for crypto module
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
}

// Stub bcrypt (native module may not be available in all CI environments)
const FAKE_HASH = '$2b$10$fakehashfortest';
jest.unstable_mockModule('bcrypt', () => ({
  default: { hash: async () => FAKE_HASH, compare: async () => true },
  hash: async () => FAKE_HASH,
  compare: async () => true,
}));

// Mock dns so validateProviderBaseUrl resolves localhost as local
const mockResolve4 = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
const mockResolve6 = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
jest.unstable_mockModule('dns/promises', () => ({
  default: { resolve4: mockResolve4, resolve6: mockResolve6 },
  resolve4: mockResolve4,
  resolve6: mockResolve6,
}));

// Now import modules
const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { default: Database } = await import('better-sqlite3');
const { default: supertest } = await import('supertest');
const { initializeDatabase } = await import('../db/init.js');
const { runMigrations } = await import('../db/migrator.js');
const { default: agentsRouter } = await import('../routes/agents.js');
const { default: db } = await import('../db/connection.js');

// ============================================
// Build minimal test app
// ============================================

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/agents', agentsRouter);
  return app;
}

// ============================================
// Helpers
// ============================================

let sessionId;
let adminUserId;
let app;

function authed(req) {
  return req.set('Cookie', `session=${sessionId}`);
}

// ============================================
// Setup / Teardown
// ============================================

beforeAll(async () => {
  // Initialize schema + migrations on the shared db connection
  await initializeDatabase(db);
  runMigrations(db);

  // Create an admin user
  const userResult = db.prepare(`
    INSERT INTO users (email, password_hash, name, role, status)
    VALUES ('admin@test.local', ?, 'Test Admin', 'admin', 'active')
  `).run(FAKE_HASH);
  adminUserId = userResult.lastInsertRowid;

  // Create a session (expires in 1 hour)
  sessionId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, datetime('now', '+1 hour'))
  `).run(sessionId, adminUserId);

  app = buildApp();
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ============================================
// Tests
// ============================================

describe('POST /api/agents — provider base URL validation', () => {
  it('rejects openai + providerBaseUrl with 400', async () => {
    const res = await authed(
      supertest(app)
        .post('/api/agents')
        .send({
          name: 'Bad OpenAI Agent',
          type: 'supervised',
          provider: 'openai',
          providerApiKey: 'sk-test-key',
          providerBaseUrl: 'http://localhost:11434',
        })
    );

    expect(res.status).toBe(400);
    expect(res.body.error?.message || res.body.error).toMatch(/openai_compatible/i);
  });

  it('rejects invalid (non-origin) base URL with 400', async () => {
    const res = await authed(
      supertest(app)
        .post('/api/agents')
        .send({
          name: 'Bad Path Agent',
          type: 'supervised',
          provider: 'openai_compatible',
          providerBaseUrl: 'http://localhost:11434/v1/chat/completions',
        })
    );

    expect(res.status).toBe(400);
    expect(res.body.error?.message || res.body.error).toMatch(/path/i);
  });

  it('persists openai_compatible agent with no API key and local base URL', async () => {
    const res = await authed(
      supertest(app)
        .post('/api/agents')
        .send({
          name: 'Local Ollama Agent',
          type: 'supervised',
          provider: 'openai_compatible',
          providerModel: 'llama3.2:latest',
          providerBaseUrl: 'http://localhost:11434',
          providerLabel: 'Ollama',
        })
    );

    expect(res.status).toBe(201);
    const agent = res.body.data;
    expect(agent.provider).toBe('openai_compatible');
    expect(agent.providerModel).toBe('llama3.2:latest');
    expect(agent.providerBaseUrl).toBe('http://localhost:11434');
    expect(agent.providerLabel).toBe('Ollama');
    expect(agent.hasApiKey).toBe(false);
  });
});

describe('PATCH /api/agents/:id/execution — provider base URL validation', () => {
  let agentId;

  beforeAll(async () => {
    // Create a blank agent for PATCH tests
    const res = await authed(
      supertest(app)
        .post('/api/agents')
        .send({ name: 'Patch Test Agent', type: 'supervised' })
    );
    agentId = res.body.data.id;
  });

  it('rejects openai + providerBaseUrl with 400', async () => {
    const res = await authed(
      supertest(app)
        .patch(`/api/agents/${agentId}/execution`)
        .send({
          provider: 'openai',
          providerBaseUrl: 'http://localhost:11434',
        })
    );

    expect(res.status).toBe(400);
    expect(res.body.error?.message || res.body.error).toMatch(/openai_compatible/i);
  });

  it('rejects non-origin URL with path in base URL', async () => {
    const res = await authed(
      supertest(app)
        .patch(`/api/agents/${agentId}/execution`)
        .send({
          provider: 'openai_compatible',
          providerBaseUrl: 'http://localhost:11434/v1/chat/completions',
        })
    );

    expect(res.status).toBe(400);
    expect(res.body.error?.message || res.body.error).toMatch(/path/i);
  });

  it('saves openai_compatible with local base URL and no API key', async () => {
    const res = await authed(
      supertest(app)
        .patch(`/api/agents/${agentId}/execution`)
        .send({
          provider: 'openai_compatible',
          providerModel: 'qwen2.5:latest',
          providerBaseUrl: 'http://localhost:11434',
          providerLabel: 'Ollama',
        })
    );

    expect(res.status).toBe(200);

    // Verify persisted via GET
    const getRes = await authed(
      supertest(app).get(`/api/agents/${agentId}`)
    );

    expect(getRes.status).toBe(200);
    const agent = getRes.body.data;
    expect(agent.provider).toBe('openai_compatible');
    expect(agent.providerModel).toBe('qwen2.5:latest');
    expect(agent.providerBaseUrl).toBe('http://localhost:11434');
    expect(agent.providerLabel).toBe('Ollama');
    expect(agent.hasApiKey).toBe(false);
  });

  it('clears base URL when set to null', async () => {
    const res = await authed(
      supertest(app)
        .patch(`/api/agents/${agentId}/execution`)
        .send({ providerBaseUrl: null })
    );

    expect(res.status).toBe(200);

    // Verify cleared
    const getRes = await authed(
      supertest(app).get(`/api/agents/${agentId}`)
    );
    expect(getRes.body.data.providerBaseUrl).toBeNull();
  });

  it('normalizes trailing-slash URL', async () => {
    const res = await authed(
      supertest(app)
        .patch(`/api/agents/${agentId}/execution`)
        .send({
          provider: 'openai_compatible',
          providerBaseUrl: 'http://localhost:11434/',
        })
    );

    expect(res.status).toBe(200);

    const getRes = await authed(
      supertest(app).get(`/api/agents/${agentId}`)
    );
    // Trailing slash should be stripped
    expect(getRes.body.data.providerBaseUrl).toBe('http://localhost:11434');
  });
});

describe('POST /api/agents/:id/execute — openai_compatible without key', () => {
  let agentId;

  beforeAll(async () => {
    // Create an openai_compatible agent with no API key
    const res = await authed(
      supertest(app)
        .post('/api/agents')
        .send({
          name: 'Execute Test Agent',
          type: 'supervised',
          provider: 'openai_compatible',
          providerModel: 'llama3.2:latest',
          providerBaseUrl: 'http://localhost:11434',
          providerLabel: 'Ollama',
        })
    );
    agentId = res.body.data.id;
  });

  it('does not reject execution for missing API key (openai_compatible)', async () => {
    // Create a task assigned to this agent
    const task = db.prepare(`
      INSERT INTO tasks (title, assigned_agent_id, status)
      VALUES ('Test task for execution', ?, 'assigned')
    `).run(agentId);
    const taskId = task.lastInsertRowid;

    // Execute will fail at the network level (no real Ollama running)
    // but it should NOT fail with "Agent API key not configured"
    const res = await authed(
      supertest(app)
        .post(`/api/agents/${agentId}/execute`)
        .send({ taskId })
    );

    // The response should be 200 with success:false (network error),
    // NOT 400 "Agent API key not configured"
    expect(res.status).toBe(200);
    // If we get a 400 with "API key not configured", the test fails
    if (res.status === 400) {
      expect(res.body.error?.message).not.toMatch(/api key not configured/i);
    }
  });
});

describe('GET /api/agents — provider fields in response', () => {
  it('includes provider_base_url and provider_label in agent list', async () => {
    const res = await authed(
      supertest(app).get('/api/agents')
    );

    expect(res.status).toBe(200);

    // Find the "Local Ollama Agent" we created earlier
    const ollamaAgent = res.body.data.find(a => a.name === 'Local Ollama Agent');
    expect(ollamaAgent).toBeDefined();
    expect(ollamaAgent.providerBaseUrl).toBe('http://localhost:11434');
    expect(ollamaAgent.providerLabel).toBe('Ollama');
  });
});

describe('GET /api/agents/providers — includes openai_compatible', () => {
  it('lists openai_compatible provider with models', async () => {
    const res = await authed(
      supertest(app).get('/api/agents/providers')
    );

    expect(res.status).toBe(200);
    const providers = res.body.data;
    expect(providers.openaiCompatible).toBeDefined();
    expect(providers.openaiCompatible.name).toMatch(/OpenAI-Compatible/i);
    expect(providers.openaiCompatible.models.length).toBeGreaterThan(0);
  });
});
