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

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
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

  test('adds Anthropic ephemeral cache blocks for system and stable user prefix', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('anthropic', 'cache ok')));

    await executeDirectAgentPrompt(makeAgent('anthropic'), {
      title: 'Cache me',
      promptCache: {
        system: true,
        userPrefix: 'Stable reusable task prefix'
      }
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.system).toEqual([{
      type: 'text',
      text: 'Custom system prompt',
      cache_control: { type: 'ephemeral' }
    }]);
    expect(body.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'Stable reusable task prefix',
      cache_control: { type: 'ephemeral' }
    });
    expect(body.messages[0].content[1].text).toContain('# Task: Cache me');
  });

  test('uses Anthropic forced tool-use for structured JSON output', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, {
      content: [{
        type: 'tool_use',
        id: 'toolu_test',
        name: 'answer_json',
        input: { answer: 'yes', count: 2 }
      }],
      usage: { input_tokens: 3, output_tokens: 4 }
    }));

    const result = await executeDirectAgentPrompt(makeAgent('anthropic'), {
      title: 'Structured Anthropic',
      structuredOutput: {
        name: 'answer_json',
        description: 'Return the answer object',
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            count: { type: 'integer' }
          },
          required: ['answer']
        }
      }
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.tools).toEqual([{
      name: 'answer_json',
      description: 'Return the answer object',
      input_schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          count: { type: 'integer' }
        },
        required: ['answer']
      }
    }]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'answer_json' });
    expect(result).toMatchObject({
      success: true,
      content: JSON.stringify({ answer: 'yes', count: 2 }),
      usage: { inputTokens: 3, outputTokens: 4 }
    });
  });

  test('sends OpenAI JSON response_format for structured output', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('openai', '{"ok":true}')));

    await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'OpenAI JSON',
      structuredOutput: true
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('sends Gemini JSON mime type and normalized response schema', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('google', '{"answer":"yes"}')));

    await executeDirectAgentPrompt(makeAgent('google'), {
      title: 'Gemini JSON',
      structuredOutput: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answer: { type: 'string' },
            count: { type: 'integer' },
            scores: {
              type: 'array',
              items: { type: 'number' }
            }
          },
          required: ['answer']
        }
      }
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual({
      type: 'OBJECT',
      properties: {
        answer: { type: 'STRING' },
        count: { type: 'INTEGER' },
        scores: {
          type: 'ARRAY',
          items: { type: 'NUMBER' }
        }
      },
      required: ['answer']
    });
  });

  test('falls back to the next model route on retryable provider errors', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(429, {
        error: { type: 'rate_limit_exceeded', message: 'Slow down' }
      }))
      .mockResolvedValueOnce(jsonResponse(200, successPayload('openai', 'route ok')));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Route retry',
      modelRoutes: [
        { provider: 'openai', model: 'gpt-first', apiKey: 'sk-first' },
        { provider: 'openai', model: 'gpt-second', apiKey: 'sk-second' }
      ]
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-first');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer sk-second');
    expect(result).toMatchObject({
      success: true,
      content: 'route ok',
      provider: 'openai',
      model: 'gpt-second',
      selectedRoute: { index: 1, provider: 'openai', model: 'gpt-second' },
      attempts: [
        { index: 0, provider: 'openai', model: 'gpt-first', status: 'failed', category: 'rate_limited', retryable: true },
        { index: 1, provider: 'openai', model: 'gpt-second', status: 'success' }
      ]
    });
  });

  test('skips model routes with missing credentials', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, successPayload('openai', 'local ok')));

    const result = await executeDirectAgentPrompt(makeAgent('openai_compatible', {
      keyless: true,
      provider_base_url: 'http://localhost:11434'
    }), {
      title: 'Route skip',
      modelRoutes: [
        { provider: 'openai', model: 'gpt-missing-key' },
        { provider: 'openai_compatible', model: 'local-model', baseUrl: 'http://localhost:11434' }
      ]
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(result).toMatchObject({
      success: true,
      model: 'local-model',
      attempts: [
        { index: 0, provider: 'openai', model: 'gpt-missing-key', status: 'skipped', category: 'config_error' },
        { index: 1, provider: 'openai_compatible', model: 'local-model', status: 'success' }
      ]
    });
  });

  test('falls back when non-streaming provider requests abort as timeouts', async () => {
    global.fetch = jest.fn()
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(jsonResponse(200, successPayload('openai', 'timeout fallback ok')));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Route timeout',
      modelRoutes: [
        { provider: 'openai', model: 'gpt-timeout', apiKey: 'sk-timeout' },
        { provider: 'openai', model: 'gpt-after-timeout', apiKey: 'sk-after-timeout' }
      ]
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      content: 'timeout fallback ok',
      model: 'gpt-after-timeout',
      attempts: [
        { index: 0, provider: 'openai', model: 'gpt-timeout', status: 'failed', category: 'timeout', retryable: true },
        { index: 1, provider: 'openai', model: 'gpt-after-timeout', status: 'success' }
      ]
    });
  });

  test('classifies provider-unavailable errors as retryable for route fallback', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(502, {
        error: { type: 'server_error', message: 'Provider temporarily unavailable' }
      }))
      .mockResolvedValueOnce(jsonResponse(200, successPayload('openai', 'provider fallback ok')));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Route provider unavailable',
      modelRoutes: [
        { provider: 'openai', model: 'gpt-unavailable', apiKey: 'sk-unavailable' },
        { provider: 'openai', model: 'gpt-available', apiKey: 'sk-available' }
      ]
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      content: 'provider fallback ok',
      model: 'gpt-available',
      attempts: [
        { index: 0, provider: 'openai', model: 'gpt-unavailable', status: 'failed', category: 'provider_unavailable', retryable: true },
        { index: 1, provider: 'openai', model: 'gpt-available', status: 'success' }
      ]
    });
  });

  test('classifies missing models as terminal and stops route fallback', async () => {
    global.fetch = jest.fn(async () => jsonResponse(404, {
      error: { code: 'model_not_found', message: "model 'gpt-missing' not found" }
    }));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Route missing model',
      modelRoutes: [
        { provider: 'openai', model: 'gpt-missing', apiKey: 'sk-missing' },
        { provider: 'openai', model: 'gpt-unused', apiKey: 'sk-unused' }
      ]
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      category: 'model_not_found',
      retryable: false,
      selectedRoute: null,
      attempts: [
        { index: 0, provider: 'openai', model: 'gpt-missing', status: 'failed', category: 'model_not_found', retryable: false }
      ]
    });
  });

  test('does not fall back to later routes on non-retryable bad requests', async () => {
    global.fetch = jest.fn(async () => jsonResponse(400, {
      error: { message: 'Bad structured output schema' }
    }));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Route bad request',
      modelRoutes: [
        { provider: 'openai', model: 'gpt-bad', apiKey: 'sk-bad' },
        { provider: 'openai', model: 'gpt-unused', apiKey: 'sk-unused' }
      ]
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      category: 'bad_request',
      retryable: false,
      selectedRoute: null,
      attempts: [
        { index: 0, provider: 'openai', model: 'gpt-bad', status: 'failed', category: 'bad_request', retryable: false }
      ]
    });
  });
});
