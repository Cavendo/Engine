import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-agent-executor-streaming-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.DB_DRIVER = 'sqlite';
process.env.SESSION_SECRET = 'test-secret-for-agent-executor-streaming';
process.env.NODE_ENV = 'test';
process.env.EXECUTION_TIMEOUT_MS = '50';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { initializeDatabase } = await import('../db/init.js');
const { runMigrations } = await import('../db/migrator.js');
const { encrypt } = await import('../utils/crypto.js');
const { executeDirectAgentPrompt } = await import('../services/agentExecutor.js');
const { default: db } = await import('../db/adapter.js');

const originalFetch = global.fetch;
const encoder = new TextEncoder();
let warnSpy;
let errorSpy;

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    }
  });
}

function sseResponse(chunks) {
  return new Response(streamFromChunks(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function abortableNeverEndingResponse(signal) {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        controller.error(err);
      });
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function defaultModel(provider) {
  if (provider === 'anthropic') return 'claude-test';
  if (provider === 'google') return 'gemini-test';
  return 'gpt-test';
}

function makeAgent(provider = 'openai', overrides = {}) {
  const { keyless = false, ...rest } = overrides;
  const key = keyless ? { encrypted: null, iv: null, keyVersion: null } : encrypt(`${provider}-test-key`);

  return {
    id: 1,
    name: 'Streaming Agent',
    capabilities: '[]',
    provider,
    provider_model: defaultModel(provider),
    provider_base_url: null,
    provider_api_key_encrypted: key.encrypted,
    provider_api_key_iv: key.iv,
    encryption_key_version: key.keyVersion,
    system_prompt: 'System prompt',
    max_tokens: 1234,
    temperature: 0.25,
    ...rest
  };
}

beforeAll(async () => {
  await initializeDatabase(db);
  await runMigrations(db);
});

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('executeDirectAgentPrompt streaming providers', () => {
  test('Anthropic streams text deltas, ignores thinking, and captures usage', async () => {
    global.fetch = jest.fn(async () => sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hidden"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ]));

    const deltas = [];
    const result = await executeDirectAgentPrompt(makeAgent('anthropic'), {
      title: 'Stream Anthropic',
      onDelta: text => deltas.push(text)
    });

    expect(result).toMatchObject({
      success: true,
      content: 'Hello',
      usage: { inputTokens: 7, outputTokens: 5 },
      provider: 'anthropic',
      model: 'claude-test'
    });
    expect(deltas).toEqual(['Hel', 'lo']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
  });

  test('does not enable streaming when onDelta is absent', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, {
      choices: [{ message: { content: 'Done' } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 }
    }));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'No stream'
    });

    expect(result).toMatchObject({
      success: true,
      content: 'Done',
      usage: { inputTokens: 2, outputTokens: 3 }
    });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.stream).toBeUndefined();
  });

  test('Anthropic mid-stream overloaded errors are classified', async () => {
    global.fetch = jest.fn(async () => sseResponse([
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
    ]));

    const result = await executeDirectAgentPrompt(makeAgent('anthropic'), {
      title: 'Anthropic error',
      onDelta: () => {}
    });

    expect(result).toMatchObject({
      success: false,
      category: 'overloaded',
      retryable: true
    });
  });

  test('Anthropic streams fail when message_stop is missing', async () => {
    global.fetch = jest.fn(async () => sseResponse([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n'
    ]));

    const result = await executeDirectAgentPrompt(makeAgent('anthropic'), {
      title: 'Missing stop',
      onDelta: () => {}
    });

    expect(result).toMatchObject({
      success: false,
      category: 'unknown',
      retryable: true
    });
    expect(result.error).toMatch(/stream ended unexpectedly/);
  });

  test('OpenAI streams deltas and requests usage on the default base URL', async () => {
    global.fetch = jest.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
      'data: [DONE]\n\n'
    ]));

    const deltas = [];
    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'OpenAI stream',
      onDelta: text => deltas.push(text)
    });

    expect(result).toMatchObject({
      success: true,
      content: 'Hi there',
      usage: { inputTokens: 3, outputTokens: 4 }
    });
    expect(deltas).toEqual(['Hi', ' there']);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test('OpenAI-compatible streams omit OpenAI-only stream_options and tolerate absent usage', async () => {
    global.fetch = jest.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Local"}}]}\n\n',
      'data: [DONE]\n\n'
    ]));

    const result = await executeDirectAgentPrompt(makeAgent('openai_compatible', {
      keyless: true,
      provider_base_url: 'http://localhost:11434'
    }), {
      title: 'Local stream',
      onDelta: () => {}
    });

    expect(result).toMatchObject({
      success: true,
      content: 'Local',
      usage: { inputTokens: undefined, outputTokens: undefined }
    });
    expect(global.fetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.stream_options).toBeUndefined();
  });

  test('OpenAI pre-stream HTTP errors are classified', async () => {
    global.fetch = jest.fn(async () => jsonResponse(401, {
      error: { type: 'authentication_error', message: 'Bad key' }
    }));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Bad auth',
      onDelta: () => {}
    });

    expect(result).toMatchObject({
      success: false,
      category: 'auth_error',
      retryable: false
    });
  });

  test('OpenAI mid-stream errors are classified', async () => {
    global.fetch = jest.fn(async () => sseResponse([
      'data: {"error":{"type":"rate_limit_exceeded","message":"Slow down"}}\n\n'
    ]));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Rate limited',
      onDelta: () => {}
    });

    expect(result).toMatchObject({
      success: false,
      category: 'rate_limited',
      retryable: true
    });
  });

  test('Google streams content chunks and treats EOF as success', async () => {
    global.fetch = jest.fn(async () => sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Gem"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"ini"}]}}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":9}}\n\n'
    ]));

    const deltas = [];
    const result = await executeDirectAgentPrompt(makeAgent('google'), {
      title: 'Google stream',
      onDelta: text => deltas.push(text)
    });

    expect(result).toMatchObject({
      success: true,
      content: 'Gemini',
      usage: { inputTokens: 8, outputTokens: 9 }
    });
    expect(deltas).toEqual(['Gem', 'ini']);
    expect(global.fetch.mock.calls[0][0]).toContain(':streamGenerateContent?alt=sse&key=');
  });

  test('throwing onDelta does not fail generation', async () => {
    global.fetch = jest.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Still works"}}]}\n\n',
      'data: [DONE]\n\n'
    ]));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Callback throws',
      onDelta: () => {
        throw new Error('consumer failure');
      }
    });

    expect(result).toMatchObject({
      success: true,
      content: 'Still works'
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  test('idle timeout aborts stalled streams', async () => {
    global.fetch = jest.fn(async (_url, options) => abortableNeverEndingResponse(options.signal));

    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Timeout',
      onDelta: () => {}
    });

    expect(result).toMatchObject({
      success: false,
      category: 'timeout',
      retryable: true
    });
  });

  test('external abort signal cancels streaming', async () => {
    const controller = new AbortController();
    global.fetch = jest.fn(async (_url, options) => abortableNeverEndingResponse(options.signal));

    setTimeout(() => controller.abort(), 0);
    const result = await executeDirectAgentPrompt(makeAgent('openai'), {
      title: 'Cancel',
      onDelta: () => {},
      signal: controller.signal
    });

    expect(result).toMatchObject({
      success: false,
      category: 'cancelled',
      retryable: false
    });
  });
});
