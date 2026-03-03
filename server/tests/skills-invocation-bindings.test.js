import { describe, expect, test, jest } from '@jest/globals';
import { createSkillsInvocationSchema } from '../utils/validation.js';
import { HttpWorkerAdapter } from '../services/skills/adapters/httpWorkerAdapter.js';

describe('skills invocation connectorBindings contract', () => {
  test('accepts valid connectorBindings map enum', () => {
    const result = createSkillsInvocationSchema.safeParse({
      skillKey: 'seo_audit',
      idempotencyKey: 'abc-123',
      connectorBindings: {
        'google:psi': 'managed',
        'google:gsc': 'none',
        'notion:workspace': 'workspace'
      }
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid connector binding enum value', () => {
    const result = createSkillsInvocationSchema.safeParse({
      skillKey: 'seo_audit',
      idempotencyKey: 'abc-123',
      connectorBindings: {
        'google:psi': 'invalid'
      }
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid connector binding key charset', () => {
    const result = createSkillsInvocationSchema.safeParse({
      skillKey: 'seo_audit',
      idempotencyKey: 'abc-123',
      connectorBindings: {
        'Bad Key!': 'managed'
      }
    });
    expect(result.success).toBe(false);
  });

  test('rejects over-length connector binding key', () => {
    const longKey = `a${'x'.repeat(200)}`; // 201 chars total
    const result = createSkillsInvocationSchema.safeParse({
      skillKey: 'seo_audit',
      idempotencyKey: 'abc-123',
      connectorBindings: {
        [longKey]: 'managed'
      }
    });
    expect(result.success).toBe(false);
  });

  test('adapter forwards connector_bindings unchanged', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ job_id: 'job_1', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    try {
      const adapter = new HttpWorkerAdapter('http://worker.local');
      await adapter.invoke({
        skill_key: 'seo_audit',
        inputs: {},
        connector_bindings: { 'google:psi': 'managed', 'google:gsc': 'none' }
      });
      const body = JSON.parse(calls[0].options.body);
      expect(body.connector_bindings).toEqual({ 'google:psi': 'managed', 'google:gsc': 'none' });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
