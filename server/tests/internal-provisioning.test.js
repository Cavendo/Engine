import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-internal-provisioning-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.SESSION_SECRET = 'test-secret-for-internal-provisioning';
process.env.INTERNAL_SERVICE_TOKEN = 'internal-provisioning-token';
process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
}

const FAKE_HASH = '$2b$10$fakehashfortest';
jest.unstable_mockModule('bcrypt', () => ({
  default: { hash: async () => FAKE_HASH, compare: async () => true },
  hash: async () => FAKE_HASH,
  compare: async () => true,
}));

const { default: express } = await import('express');
const { default: cookieParser } = await import('cookie-parser');
const { default: supertest } = await import('supertest');
const { initializeDatabase } = await import('../db/init.js');
const { runMigrations } = await import('../db/migrator.js');
const { default: internalProvisioningRouter } = await import('../routes/internalProvisioning.js');
const { default: projectsRouter } = await import('../routes/projects.js');
const { hashApiKey } = await import('../utils/crypto.js');
const { default: db } = await import('../db/adapter.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/internal/provisioning', internalProvisioningRouter);
  app.use('/api/projects', projectsRouter);
  return app;
}

let app;
let sessionId;
let agentKey;

function internal(req) {
  return req
    .set('Authorization', 'Bearer internal-provisioning-token')
    .set('X-Internal-Service-Name', 'workflow_engine');
}

function authed(req) {
  return req.set('Cookie', `session=${sessionId}`);
}

beforeAll(async () => {
  await initializeDatabase(db);
  await runMigrations(db);

  const { lastInsertRowid: userId } = await db.insert(`
    INSERT INTO users (email, password_hash, name, role, status)
    VALUES ('admin@test.local', ?, 'Test Admin', 'admin', 'active')
  `, [FAKE_HASH]);

  sessionId = crypto.randomUUID();
  await db.exec(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, datetime('now', '+1 hour'))
  `, [sessionId, userId]);

  const { lastInsertRowid: agentId } = await db.insert(`
    INSERT INTO agents (name, type, status, capabilities)
    VALUES ('Route Agent', 'supervised', 'active', '[]')
  `, []);

  agentKey = 'cav_ak_test_internal_provisioning_key';
  await db.insert(`
    INSERT INTO agent_keys (agent_id, key_hash, key_prefix, scopes)
    VALUES (?, ?, ?, ?)
  `, [agentId, hashApiKey(agentKey), 'cav_ak_t', '["read","write"]']);

  app = buildApp();
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('internal provisioning auth', () => {
  test('rejects missing bearer token', async () => {
    const res = await supertest(app)
      .post('/api/internal/provisioning/projects/ensure')
      .send({ externalKey: 'proj:missing-auth', name: 'Missing Auth' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('rejects agent key auth for provisioning endpoints', async () => {
    const res = await supertest(app)
      .post('/api/internal/provisioning/projects/ensure')
      .set('X-Agent-Key', agentKey)
      .send({ externalKey: 'proj:agent-key', name: 'Agent Key Attempt' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/internal/provisioning/projects/ensure', () => {
  test('creates a new project by externalKey', async () => {
    const res = await internal(
      supertest(app)
        .post('/api/internal/provisioning/projects/ensure')
        .send({
          externalKey: 'proj:acme',
          name: 'Acme Project',
          description: 'Provisioned by workflow',
          status: 'active'
        })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.project.externalKey).toBe('proj:acme');
    expect(res.body.data.project.name).toBe('Acme Project');
  });

  test('replays by externalKey and updates mutable fields', async () => {
    const res = await internal(
      supertest(app)
        .post('/api/internal/provisioning/projects/ensure')
        .send({
          externalKey: 'proj:acme',
          name: 'Acme Project Renamed',
          description: 'Updated description',
          status: 'archived'
        })
    );

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(false);
    expect(res.body.data.project.name).toBe('Acme Project Renamed');
    expect(res.body.data.project.description).toBe('Updated description');
    expect(res.body.data.project.status).toBe('archived');
  });

  test('returns 409 when creating a different externalKey with an existing name', async () => {
    const res = await internal(
      supertest(app)
        .post('/api/internal/provisioning/projects/ensure')
        .send({
          externalKey: 'proj:duplicate-name',
          name: 'Acme Project Renamed'
        })
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROJECT_NAME_CONFLICT');
  });
});

describe('POST /api/internal/provisioning/projects/:externalKey/routing-rules/ensure', () => {
  let defaultAgentId;
  let fallbackAgentId;

  beforeAll(async () => {
    const first = await db.insert(`
      INSERT INTO agents (name, type, status, capabilities)
      VALUES ('Primary Route Agent', 'supervised', 'active', '[]')
    `, []);
    defaultAgentId = first.lastInsertRowid;

    const second = await db.insert(`
      INSERT INTO agents (name, type, status, capabilities)
      VALUES ('Fallback Route Agent', 'supervised', 'active', '[]')
    `, []);
    fallbackAgentId = second.lastInsertRowid;
  });

  test('replaces routing config exactly with the payload', async () => {
    const firstRes = await internal(
      supertest(app)
        .post('/api/internal/provisioning/projects/proj:acme/routing-rules/ensure')
        .send({
          taskRoutingRules: [
            {
              id: 'priority-high',
              name: 'Priority High',
              conditions: { priority: { eq: 1 } },
              assign_to: defaultAgentId,
              fallback_to: fallbackAgentId,
              enabled: true
            }
          ],
          defaultAgentId
        })
    );

    expect(firstRes.status).toBe(200);
    expect(firstRes.body.data.projectId).toBeDefined();
    expect(firstRes.body.data.taskRoutingRules).toHaveLength(1);
    expect(firstRes.body.data.defaultAgentId).toBe(defaultAgentId);

    const secondRes = await internal(
      supertest(app)
        .post('/api/internal/provisioning/projects/proj:acme/routing-rules/ensure')
        .send({
          taskRoutingRules: [
            {
              id: 'capability-seo',
              name: 'SEO Tasks',
              conditions: { tags: { includes_any: ['seo'] } },
              assign_to_capability: 'seo',
              fallback_to: fallbackAgentId,
              enabled: true
            }
          ],
          defaultAgentId: fallbackAgentId
        })
    );

    expect(secondRes.status).toBe(200);
    expect(secondRes.body.data.taskRoutingRules).toHaveLength(1);
    expect(secondRes.body.data.taskRoutingRules[0].id).toBe('capability-seo');
    expect(secondRes.body.data.defaultAgentId).toBe(fallbackAgentId);

    const project = await db.one(
      'SELECT task_routing_rules, default_agent_id FROM projects WHERE external_key = ?',
      ['proj:acme']
    );
    expect(JSON.parse(project.task_routing_rules)).toHaveLength(1);
    expect(JSON.parse(project.task_routing_rules)[0].id).toBe('capability-seo');
    expect(project.default_agent_id).toBe(fallbackAgentId);
  });

  test('returns 422 for invalid agent IDs', async () => {
    const res = await internal(
      supertest(app)
        .post('/api/internal/provisioning/projects/proj:acme/routing-rules/ensure')
        .send({
          taskRoutingRules: [
            {
              name: 'Broken Rule',
              assign_to: 999999
            }
          ]
        })
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 for unknown externalKey', async () => {
    const res = await internal(
      supertest(app)
        .post('/api/internal/provisioning/projects/proj:missing/routing-rules/ensure')
        .send({
          taskRoutingRules: [],
          defaultAgentId: null
        })
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('public project routes regression', () => {
  test('existing admin project read does not expose externalKey', async () => {
    const projectRow = await db.one(
      'SELECT id FROM projects WHERE external_key = ?',
      ['proj:acme']
    );

    const res = await authed(
      supertest(app).get(`/api/projects/${projectRow.id}`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Acme Project Renamed');
    expect(res.body.data.externalKey).toBeUndefined();
  });

  test('existing agent project read still works', async () => {
    const res = await supertest(app)
      .get('/api/projects')
      .set('X-Agent-Key', agentKey);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.some(project => project.name === 'Acme Project Renamed')).toBe(true);
  });
});
