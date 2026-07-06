import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-agent-executor-direct-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.DB_DRIVER = 'sqlite';
process.env.SESSION_SECRET = 'test-secret-for-agent-executor-direct';
process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { initializeDatabase } = await import('../db/init.js');
const { runMigrations } = await import('../db/migrator.js');
const { encrypt } = await import('../utils/crypto.js');
const { executeDirectAgentPrompt } = await import('../services/agentExecutor.js');
const { default: db } = await import('../db/adapter.js');

const originalFetch = global.fetch;
let errorSpy;

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function successPayload(provider, content = 'ok') {
  if (provider === 'anthropic') {
    return {
      content: [{ text: content }],
      usage: { input_tokens: 1, output_tokens: 2 }
    };
  }
  if (provider === 'google') {
    return {
      candidates: [{ content: { parts: [{ text: content }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 }
    };
  }
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 2 }
  };
}

function makeAgent(provider = 'openai', overrides = {}) {
  const { keyless = false, apiKey = `${provider}-test-key`, ...rest } = overrides;
  const key = keyless ? { encrypted: null, iv: null, keyVersion: null } : encrypt(apiKey);

  return {
    id: 1,
    name: 'Direct Agent',
    capabilities: '["writing"]',
    provider,
    provider_model: provider === 'google' ? 'gemini-test' : provider === 'anthropic' ? 'claude-test' : 'gpt-test',
    provider_base_url: null,
    provider_api_key_encrypted: key.encrypted,
    provider_api_key_iv: key.iv,
    encryption_key_version: key.keyVersion,
    system_prompt: 'Custom system prompt',
    max_tokens: 111,
    temperature: 0.5,
    ...rest
  };
}

beforeAll(async () => {
  await initializeDatabase(db);
  await runMigrations(db);
});

afterEach(async () => {
  global.fetch = originalFetch;
  errorSpy?.mockRestore();
  errorSpy = null;
  await db.exec('DELETE FROM knowledge', []);
  await db.exec('DELETE FROM tasks', []);
  await db.exec('DELETE FROM projects', []);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('executeDirectAgentPrompt', () => {
  test('returns config_error for missing non-local provider keys without calling fetch', async () => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn();

    const result = await executeDirectAgentPrompt(makeAgent('openai', { keyless: true }), {
      title: 'Missing key'
    });

    expect(result).toMatchObject({
      success: false,
      category: 'config_error',
      retryable: true
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('decrypts provider API keys before calling Anthropic', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('anthropic', 'anthropic ok')));

    const result = await executeDirectAgentPrompt(makeAgent('anthropic', { apiKey: 'sk-ant-secret' }), {
      title: 'Decrypt key'
    });

    expect(result).toMatchObject({
      success: true,
      content: 'anthropic ok',
      usage: { inputTokens: 1, outputTokens: 2 },
      provider: 'anthropic',
      model: 'claude-test'
    });
    expect(global.fetch.mock.calls[0][1].headers['x-api-key']).toBe('sk-ant-secret');
  });

  test('allows keyless openai_compatible agents and omits Authorization', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('openai', 'local ok')));

    const result = await executeDirectAgentPrompt(makeAgent('openai_compatible', {
      keyless: true,
      provider_base_url: 'http://localhost:11434'
    }), {
      title: 'Local direct'
    });

    expect(result).toMatchObject({
      success: true,
      content: 'local ok',
      provider: 'openai_compatible'
    });
    expect(global.fetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  test('assembles title, description, and context into the user prompt', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('openai', 'prompt ok')));

    await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Prompt Title',
      description: 'Prompt description',
      context: { customer: 'Acme', tier: 'gold' }
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Custom system prompt' });
    expect(body.messages[1].content).toContain('# Task: Prompt Title');
    expect(body.messages[1].content).toContain('Prompt description');
    expect(body.messages[1].content).toContain('"customer": "Acme"');
    expect(body.messages[1].content).toContain('"tier": "gold"');
  });

  test('includes project knowledge when projectId is provided', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('openai', 'knowledge ok')));

    const project = await db.insert(`
      INSERT INTO projects (name, description)
      VALUES ('Knowledge Project', 'Project description')
    `, []);
    const projectId = project.lastInsertRowid;
    await db.insert(`
      INSERT INTO knowledge (project_id, title, content, content_type, category, tags)
      VALUES (?, 'Brand Voice', 'Use a calm expert tone.', 'markdown', 'guideline', '["voice"]')
    `, [projectId]);

    await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'With knowledge',
      projectId
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages[1].content).toContain('## Project: Knowledge Project');
    expect(body.messages[1].content).toContain('## Project Knowledge Base');
    expect(body.messages[1].content).toContain('### Brand Voice (guideline)');
    expect(body.messages[1].content).toContain('Use a calm expert tone.');
  });

  test('applies max token precedence', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('openai', 'tokens ok')));
    const agent = makeAgent('openai', { max_tokens: 111 });

    await executeDirectAgentPrompt(agent, { title: 'snake', max_tokens: 222 });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_tokens).toBe(222);

    await executeDirectAgentPrompt(agent, { title: 'camel', maxTokens: 333, max_tokens: 222 });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).max_tokens).toBe(333);

    await executeDirectAgentPrompt(agent, { title: 'agent default' });
    expect(JSON.parse(global.fetch.mock.calls[2][1].body).max_tokens).toBe(111);
  });

  test('returns provider/model success shape for direct prompts', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('google', 'google ok')));

    const result = await executeDirectAgentPrompt(makeAgent('google'), {
      title: 'Success shape'
    });

    expect(result).toEqual({
      success: true,
      content: 'google ok',
      usage: { inputTokens: 1, outputTokens: 2 },
      provider: 'google',
      model: 'gemini-test'
    });
  });

  test('returns config_error for unsupported providers without calling fetch', async () => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn();

    const result = await executeDirectAgentPrompt(makeAgent('unsupported'), {
      title: 'Unsupported'
    });

    expect(result).toMatchObject({
      success: false,
      category: 'config_error',
      retryable: false
    });
    expect(result.error).toMatch(/Unsupported provider/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
