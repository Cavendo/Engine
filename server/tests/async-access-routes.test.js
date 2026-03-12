import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-async-access-routes-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.SESSION_SECRET = 'test-secret-for-async-access-routes';
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
const { default: tasksRouter } = await import('../routes/tasks.js');
const { default: commentsRouter } = await import('../routes/comments.js');
const { hashApiKey } = await import('../utils/crypto.js');
const { default: db } = await import('../db/adapter.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/tasks', tasksRouter);
  app.use('/api', commentsRouter);
  return app;
}

let app;
let taskId;
let deliverableId;
let userKey;

function authed(req) {
  return req.set('X-Agent-Key', userKey);
}

beforeAll(async () => {
  await initializeDatabase(db);
  await runMigrations(db);

  const { lastInsertRowid: userId } = await db.insert(`
    INSERT INTO users (email, password_hash, name, role, status)
    VALUES ('reader@test.local', ?, 'Reader User', 'reviewer', 'active')
  `, [FAKE_HASH]);

  userKey = 'cav_uk_async_access_regression';
  await db.insert(`
    INSERT INTO user_keys (user_id, key_hash, key_prefix, name)
    VALUES (?, ?, ?, ?)
  `, [userId, hashApiKey(userKey), 'cav_uk_a', 'Async Access Key']);

  const { lastInsertRowid: projectId } = await db.insert(`
    INSERT INTO projects (name, description, status)
    VALUES ('Async Access Project', 'Regression coverage', 'active')
  `, []);

  const taskResult = await db.insert(`
    INSERT INTO tasks (project_id, title, description, status, priority, tags, context)
    VALUES (?, ?, ?, 'pending', 2, '[]', '{}')
  `, [projectId, 'Accessible Task', 'Used to verify awaited auth checks']);
  taskId = taskResult.lastInsertRowid;

  const deliverableResult = await db.insert(`
    INSERT INTO deliverables (task_id, project_id, title, summary, content, status, version)
    VALUES (?, ?, ?, ?, ?, 'pending', 1)
  `, [taskId, projectId, 'Accessible Deliverable', 'Regression summary', 'Regression content']);
  deliverableId = deliverableResult.lastInsertRowid;

  await db.insert(`
    INSERT INTO comments (content, commentable_type, commentable_id, author_type, author_id, author_name)
    VALUES (?, 'task', ?, 'user', ?, ?)
  `, ['Task comment', taskId, userId, 'Reader User']);

  await db.insert(`
    INSERT INTO comments (content, commentable_type, commentable_id, author_type, author_id, author_name)
    VALUES (?, 'deliverable', ?, 'user', ?, ?)
  `, ['Deliverable comment', deliverableId, userId, 'Reader User']);

  app = buildApp();
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('async authorization helpers are awaited in read routes', () => {
  test('user key can fetch task detail and activity', async () => {
    const detailRes = await authed(supertest(app).get(`/api/tasks/${taskId}`));
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.id).toBe(taskId);
    expect(detailRes.body.data.title).toBe('Accessible Task');

    const activityRes = await authed(supertest(app).get(`/api/tasks/${taskId}/activity`));
    expect(activityRes.status).toBe(200);
    expect(Array.isArray(activityRes.body.data)).toBe(true);
  });

  test('user key can fetch task and deliverable comments', async () => {
    const taskCommentsRes = await authed(supertest(app).get(`/api/tasks/${taskId}/comments`));
    expect(taskCommentsRes.status).toBe(200);
    expect(taskCommentsRes.body.data).toHaveLength(1);
    expect(taskCommentsRes.body.data[0].content).toBe('Task comment');

    const deliverableCommentsRes = await authed(
      supertest(app).get(`/api/deliverables/${deliverableId}/comments`)
    );
    expect(deliverableCommentsRes.status).toBe(200);
    expect(deliverableCommentsRes.body.data).toHaveLength(1);
    expect(deliverableCommentsRes.body.data[0].content).toBe('Deliverable comment');
  });
});
