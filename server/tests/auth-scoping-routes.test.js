import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-auth-scoping-routes-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.DB_DRIVER = 'sqlite';
process.env.SESSION_SECRET = 'test-secret-for-auth-scoping-routes';
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
const { default: deliverablesRouter } = await import('../routes/deliverables.js');
const { default: agentsRouter } = await import('../routes/agents.js');
const { hashApiKey } = await import('../utils/crypto.js');
const { default: db } = await import('../db/adapter.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/tasks', tasksRouter);
  app.use('/api/deliverables', deliverablesRouter);
  app.use('/api/agents', agentsRouter);
  return app;
}

let app;
let adminUserId;
let projectId;
let agentOneId;
let agentTwoId;
let taskOneId;
let taskTwoId;
let deletableTaskId;
let claimTakeoverTaskId;
let reviewApproveTaskId;
let reviewReviseTaskId;
let deliverableOneId;
let deliverableTwoId;
let reviewApproveDeliverableId;
let reviewReviseDeliverableId;
let userApiKey;
let agentOneKey;
let agentOneSecondKey;
const permissiveProjectAccessKeys = [];
const malformedProjectAccessKeys = [];

beforeAll(async () => {
  await initializeDatabase(db);
  await runMigrations(db);

  const { lastInsertRowid: userId } = await db.insert(`
    INSERT INTO users (email, password_hash, name, role, status)
    VALUES ('admin-auth@test.local', ?, 'Auth Admin', 'admin', 'active')
  `, [FAKE_HASH]);
  adminUserId = userId;

  userApiKey = 'cav_uk_auth_scoping_admin';
  await db.insert(`
    INSERT INTO user_keys (user_id, key_hash, key_prefix, name)
    VALUES (?, ?, ?, ?)
  `, [userId, hashApiKey(userApiKey), userApiKey.slice(0, 15), 'Auth scoping user key']);

  const project = await db.insert(`
    INSERT INTO projects (name, description, status)
    VALUES ('Auth Scoping Project', 'Regression fixture', 'active')
  `, []);
  projectId = project.lastInsertRowid;

  const agentOne = await db.insert(`
    INSERT INTO agents (name, type, status, execution_mode, owner_user_id, project_access)
    VALUES ('Scoped Agent One', 'supervised', 'active', 'polling', ?, ?)
  `, [adminUserId, JSON.stringify([String(projectId)])]);
  agentOneId = agentOne.lastInsertRowid;

  const agentTwo = await db.insert(`
    INSERT INTO agents (name, type, status, execution_mode, owner_user_id, project_access)
    VALUES ('Scoped Agent Two', 'supervised', 'active', 'polling', ?, ?)
  `, [adminUserId, JSON.stringify([String(projectId)])]);
  agentTwoId = agentTwo.lastInsertRowid;

  agentOneKey = 'cav_ak_auth_scoping_one';
  agentOneSecondKey = 'cav_ak_auth_scoping_one_second';
  await db.insert(`
    INSERT INTO agent_keys (agent_id, key_hash, key_prefix, name)
    VALUES (?, ?, ?, ?)
  `, [agentOneId, hashApiKey(agentOneKey), agentOneKey.slice(0, 12), 'Primary scoped agent key']);
  await db.insert(`
    INSERT INTO agent_keys (agent_id, key_hash, key_prefix, name)
    VALUES (?, ?, ?, ?)
  `, [agentOneId, hashApiKey(agentOneSecondKey), agentOneSecondKey.slice(0, 12), 'Second scoped agent key']);

  for (const fixture of [
    { label: 'empty', projectAccess: '' },
    { label: 'null_db', projectAccess: null },
  ]) {
    const agent = await db.insert(`
      INSERT INTO agents (name, type, status, execution_mode, project_access)
      VALUES (?, 'supervised', 'active', 'polling', ?)
    `, [`Default Project Access ${fixture.label}`, fixture.projectAccess]);
    const key = `cav_ak_project_access_default_${fixture.label}`;
    permissiveProjectAccessKeys.push(key);
    await db.insert(`
      INSERT INTO agent_keys (agent_id, key_hash, key_prefix, name)
      VALUES (?, ?, ?, ?)
    `, [agent.lastInsertRowid, hashApiKey(key), key.slice(0, 12), `Default project access ${fixture.label}`]);
  }

  for (const fixture of [
    { label: 'null_json', projectAccess: 'null' },
    { label: 'object_json', projectAccess: JSON.stringify({ projects: [String(projectId)] }) },
    { label: 'invalid_json', projectAccess: '{"projects":' },
  ]) {
    const agent = await db.insert(`
      INSERT INTO agents (name, type, status, execution_mode, project_access)
      VALUES (?, 'supervised', 'active', 'polling', ?)
    `, [`Malformed Project Access ${fixture.label}`, fixture.projectAccess]);
    const key = `cav_ak_project_access_${fixture.label}`;
    malformedProjectAccessKeys.push(key);
    await db.insert(`
      INSERT INTO agent_keys (agent_id, key_hash, key_prefix, name)
      VALUES (?, ?, ?, ?)
    `, [agent.lastInsertRowid, hashApiKey(key), key.slice(0, 12), `Malformed project access ${fixture.label}`]);
  }

  const taskOne = await db.insert(`
    INSERT INTO tasks (project_id, assigned_agent_id, title, description, status, priority, tags, context)
    VALUES (?, ?, 'Scoped Task One', 'Owned by agent one', 'assigned', 2, '[]', '{}')
  `, [projectId, agentOneId]);
  taskOneId = taskOne.lastInsertRowid;

  const taskTwo = await db.insert(`
    INSERT INTO tasks (project_id, assigned_agent_id, title, description, status, priority, tags, context)
    VALUES (?, ?, 'Scoped Task Two', 'Owned by agent two', 'assigned', 2, '[]', '{}')
  `, [projectId, agentTwoId]);
  taskTwoId = taskTwo.lastInsertRowid;

  const claimTakeoverTask = await db.insert(`
    INSERT INTO tasks (project_id, assigned_agent_id, title, description, status, priority, tags, context)
    VALUES (?, ?, 'Claim Takeover Task', 'Owned user key should be able to reclaim this', 'assigned', 2, '[]', '{}')
  `, [projectId, agentOneId]);
  claimTakeoverTaskId = claimTakeoverTask.lastInsertRowid;

  const reviewApproveTask = await db.insert(`
    INSERT INTO tasks (project_id, assigned_agent_id, title, description, status, priority, tags, context)
    VALUES (?, ?, 'Review Approval Task', 'Reviewed by user key', 'review', 2, '[]', '{}')
  `, [projectId, agentOneId]);
  reviewApproveTaskId = reviewApproveTask.lastInsertRowid;

  const reviewReviseTask = await db.insert(`
    INSERT INTO tasks (project_id, assigned_agent_id, title, description, status, priority, tags, context)
    VALUES (?, ?, 'Review Revision Task', 'Revision requested by user key', 'review', 2, '[]', '{}')
  `, [projectId, agentOneId]);
  reviewReviseTaskId = reviewReviseTask.lastInsertRowid;

  const deletableTask = await db.insert(`
    INSERT INTO tasks (project_id, title, description, status, priority, tags, context)
    VALUES (?, 'User Key Deletable Task', 'Used for role-gated user-key auth', 'pending', 2, '[]', '{}')
  `, [projectId]);
  deletableTaskId = deletableTask.lastInsertRowid;

  const deliverableOne = await db.insert(`
    INSERT INTO deliverables (task_id, project_id, agent_id, title, summary, content, status, version)
    VALUES (?, ?, ?, 'Scoped Deliverable One', 'Owned summary', 'Owned content', 'pending', 1)
  `, [taskOneId, projectId, agentOneId]);
  deliverableOneId = deliverableOne.lastInsertRowid;

  const deliverableTwo = await db.insert(`
    INSERT INTO deliverables (task_id, project_id, agent_id, title, summary, content, status, version)
    VALUES (?, ?, ?, 'Scoped Deliverable Two', 'Other summary', 'Other content', 'pending', 1)
  `, [taskTwoId, projectId, agentTwoId]);
  deliverableTwoId = deliverableTwo.lastInsertRowid;

  const reviewApproveDeliverable = await db.insert(`
    INSERT INTO deliverables (task_id, project_id, agent_id, title, summary, content, status, version)
    VALUES (?, ?, ?, 'Review Approval Deliverable', 'Approval summary', 'Approval content', 'pending', 1)
  `, [reviewApproveTaskId, projectId, agentOneId]);
  reviewApproveDeliverableId = reviewApproveDeliverable.lastInsertRowid;

  const reviewReviseDeliverable = await db.insert(`
    INSERT INTO deliverables (task_id, project_id, agent_id, title, summary, content, status, version)
    VALUES (?, ?, ?, 'Review Revision Deliverable', 'Revision summary', 'Revision content', 'pending', 1)
  `, [reviewReviseTaskId, projectId, agentOneId]);
  reviewReviseDeliverableId = reviewReviseDeliverable.lastInsertRowid;

  await db.insert(`
    INSERT INTO knowledge (project_id, title, content, content_type, category, tags)
    VALUES (?, 'Project Memory', 'Knowledge context that should be returned.', 'markdown', 'notes', ?)
  `, [projectId, JSON.stringify(['regression'])]);

  app = buildApp();
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('regular agent key route scoping', () => {
  test('task list is scoped to tasks assigned to the calling agent', async () => {
    const res = await supertest(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${agentOneKey}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((task) => task.id);
    expect(ids).toContain(taskOneId);
    expect(ids).not.toContain(taskTwoId);
  });

  test('deliverable list is scoped to deliverables for the calling agent', async () => {
    const res = await supertest(app)
      .get('/api/deliverables')
      .set('Authorization', `Bearer ${agentOneKey}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((deliverable) => deliverable.id);
    expect(ids).toContain(deliverableOneId);
    expect(ids).not.toContain(deliverableTwoId);
  });

  test('agent keys cannot use human/admin task routes', async () => {
    const res = await supertest(app)
      .post('/api/tasks/bulk')
      .set('Authorization', `Bearer ${agentOneKey}`)
      .send({
        tasks: [{
          title: 'Agent should not create this',
          projectId,
        }]
      });

    expect(res.status).toBe(403);
  });

  test('admin user API keys can use human/admin task routes', async () => {
    const res = await supertest(app)
      .delete('/api/tasks/bulk')
      .set('Authorization', `Bearer ${userApiKey}`)
      .send({
        taskIds: [deletableTaskId]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(1);
    expect(res.body.data.summary.successful).toBe(1);
  });

  test('nullish or empty project_access uses the wildcard default', async () => {
    for (const key of permissiveProjectAccessKeys) {
      const res = await supertest(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${key}`)
        .send({
          title: `Allowed task for ${key}`,
          projectId,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.projectId).toBe(projectId);
    }
  });

  test('malformed project_access denies regular agent task creation', async () => {
    for (const key of malformedProjectAccessKeys) {
      const res = await supertest(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${key}`)
        .send({
          title: `Denied task for ${key}`,
          projectId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error?.message).toMatch(/Project access denied/);
    }
  });
});

describe('task context and claim regressions', () => {
  test('task context includes generic project knowledge', async () => {
    const res = await supertest(app)
      .get(`/api/tasks/${taskOneId}/context`)
      .set('Authorization', `Bearer ${agentOneKey}`);

    expect(res.status).toBe(200);
    expect(res.body.data.knowledge).toHaveLength(1);
    expect(res.body.data.knowledge[0]).toMatchObject({
      title: 'Project Memory',
      content: 'Knowledge context that should be returned.',
      tags: ['regression'],
    });
    expect(res.body.data.contextPlan).toBeUndefined();
    expect(res.body.data.taskMaterials).toBeUndefined();
    expect(res.body.data.contextBuckets).toBeUndefined();
    expect(res.body.data.retrievalAudit).toBeUndefined();
  });

  test('concurrent task claims allow exactly one worker key to win', async () => {
    const [first, second] = await Promise.all([
      supertest(app)
        .post(`/api/agents/me/tasks/${taskOneId}/claim`)
        .set('Authorization', `Bearer ${agentOneKey}`)
        .send({ leaseSeconds: 60 }),
      supertest(app)
        .post(`/api/agents/me/tasks/${taskOneId}/claim`)
        .set('Authorization', `Bearer ${agentOneSecondKey}`)
        .send({ leaseSeconds: 60 }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = [first, second].find((res) => res.status === 409);
    expect(conflict.body.error?.code).toBe('TASK_ALREADY_CLAIMED');
  });

  test('user key can take over an active lease for an owned agent', async () => {
    const firstClaim = await supertest(app)
      .post(`/api/agents/me/tasks/${claimTakeoverTaskId}/claim`)
      .set('Authorization', `Bearer ${agentOneKey}`)
      .send({ leaseSeconds: 60 });

    expect(firstClaim.status).toBe(200);
    expect(firstClaim.body.data.lease.claimantId).toMatch(new RegExp(`^agent:${agentOneId}:key:`));

    const takeover = await supertest(app)
      .post(`/api/agents/me/tasks/${claimTakeoverTaskId}/claim`)
      .set('Authorization', `Bearer ${userApiKey}`)
      .send({ leaseSeconds: 60, agentId: agentOneId });

    expect(takeover.status).toBe(200);
    expect(takeover.body.data.lease.claimantId).toMatch(new RegExp(`^agent:${agentOneId}:key:`));

    const task = await db.one('SELECT agent_claimed_by FROM tasks WHERE id = ?', [claimTakeoverTaskId]);
    expect(task.agent_claimed_by).toBe(takeover.body.data.lease.claimantId);
  });
});

describe('user key deliverable review regressions', () => {
  test('user API key can approve a deliverable review', async () => {
    const res = await supertest(app)
      .patch(`/api/deliverables/${reviewApproveDeliverableId}/review`)
      .set('Authorization', `Bearer ${userApiKey}`)
      .send({
        decision: 'approved',
        feedback: 'Looks good',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.reviewedBy).toBe('admin-auth@test.local');

    const task = await db.one('SELECT status FROM tasks WHERE id = ?', [reviewApproveTaskId]);
    expect(task.status).toBe('completed');
  });

  test('user API key can request a revision', async () => {
    const res = await supertest(app)
      .patch(`/api/deliverables/${reviewReviseDeliverableId}/review`)
      .set('Authorization', `Bearer ${userApiKey}`)
      .send({
        decision: 'revision_requested',
        feedback: 'Please revise the conclusion.',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('revision_requested');
    expect(res.body.data.reviewedBy).toBe('admin-auth@test.local');

    const task = await db.one('SELECT status, context FROM tasks WHERE id = ?', [reviewReviseTaskId]);
    const context = JSON.parse(task.context);
    expect(task.status).toBe('assigned');
    expect(context.latest_revision_feedback).toBe('Please revise the conclusion.');
    expect(context.latest_revision_request.requested_by).toBe('admin-auth@test.local');
  });
});
