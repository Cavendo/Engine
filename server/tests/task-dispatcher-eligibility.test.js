import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-task-dispatcher-eligibility-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.DB_DRIVER = 'sqlite';
process.env.SESSION_SECRET = 'test-secret-for-dispatcher-eligibility';
process.env.NODE_ENV = 'test';
process.env.DISPATCHER_BATCH_SIZE = '20';
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
}

const { initializeDatabase } = await import('../db/init.js');
const { runMigrations } = await import('../db/migrator.js');
const { default: db } = await import('../db/adapter.js');
const { classifyErrorMessage, findEligibleTasks } = await import('../services/taskDispatcher.js');

async function createAgent({ name, executionMode, provider = 'openai', apiKey = 'encrypted', baseUrl = null }) {
  const result = await db.insert(`
    INSERT INTO agents (
      name, type, status, execution_mode, provider, provider_api_key_encrypted,
      provider_base_url, active_task_count, max_concurrent_tasks
    )
    VALUES (?, 'supervised', 'active', ?, ?, ?, ?, 0, 5)
  `, [name, executionMode, provider, apiKey, baseUrl]);
  return result.lastInsertRowid;
}

async function createTask(projectId, agentId, title, context = {}) {
  const result = await db.insert(`
    INSERT INTO tasks (project_id, assigned_agent_id, title, description, status, priority, tags, context)
    VALUES (?, ?, ?, 'Dispatcher regression task', 'pending', 2, '[]', ?)
  `, [projectId, agentId, title, JSON.stringify(context)]);
  return result.lastInsertRowid;
}

let projectId;
let autoTaskId;
let manualWorkflowTaskId;
let pollingWorkflowTaskId;
let compatibleNoKeyTaskId;
let openAiMissingKeyTaskId;

beforeAll(async () => {
  await initializeDatabase(db);
  await runMigrations(db);

  const project = await db.insert(`
    INSERT INTO projects (name, description, status)
    VALUES ('Dispatcher Project', 'Regression fixture', 'active')
  `, []);
  projectId = project.lastInsertRowid;

  const autoAgentId = await createAgent({ name: 'Auto OpenAI Agent', executionMode: 'auto' });
  const manualAgentId = await createAgent({ name: 'Manual Workflow Agent', executionMode: 'manual' });
  const pollingAgentId = await createAgent({ name: 'Polling Workflow Agent', executionMode: 'polling' });
  const compatibleNoKeyAgentId = await createAgent({
    name: 'Compatible Local Agent',
    executionMode: 'auto',
    provider: 'openai_compatible',
    apiKey: null,
    baseUrl: 'http://localhost:11434',
  });
  const openAiMissingKeyAgentId = await createAgent({
    name: 'OpenAI Missing Key Agent',
    executionMode: 'auto',
    provider: 'openai',
    apiKey: null,
  });

  autoTaskId = await createTask(projectId, autoAgentId, 'Auto task');
  manualWorkflowTaskId = await createTask(projectId, manualAgentId, 'Manual task with workflow context', { workflowRunId: 'client-controlled' });
  pollingWorkflowTaskId = await createTask(projectId, pollingAgentId, 'Polling task with workflow context', { workflowRunId: 'client-controlled' });
  compatibleNoKeyTaskId = await createTask(projectId, compatibleNoKeyAgentId, 'OpenAI-compatible keyless task');
  openAiMissingKeyTaskId = await createTask(projectId, openAiMissingKeyAgentId, 'OpenAI missing key task');
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dispatcher eligibility', () => {
  test('requires auto execution mode and runnable provider configuration', async () => {
    const eligible = await findEligibleTasks();
    const ids = eligible.map((row) => row.task_id);

    expect(ids).toContain(autoTaskId);
    expect(ids).toContain(compatibleNoKeyTaskId);
    expect(ids).not.toContain(manualWorkflowTaskId);
    expect(ids).not.toContain(pollingWorkflowTaskId);
    expect(ids).not.toContain(openAiMissingKeyTaskId);
  });

  test('classifies transient provider errors before quota wording', () => {
    expect(classifyErrorMessage('429 insufficient_quota: out of credits'))
      .toBe('quota_exceeded');
    expect(classifyErrorMessage('429 rate limit reached; add a payment method to increase limits'))
      .toBe('rate_limited');
    expect(classifyErrorMessage('503 planned maintenance'))
      .toBe('overloaded');
    expect(classifyErrorMessage('billing limit exceeded'))
      .toBe('quota_exceeded');
    expect(classifyErrorMessage('provider rejected request: add a payment method to continue'))
      .toBe('quota_exceeded');
  });
});
