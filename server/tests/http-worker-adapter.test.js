import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { HttpWorkerAdapter } from '../services/skills/adapters/httpWorkerAdapter.js';

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('HttpWorkerAdapter worker v1 contract', () => {
  const originalFetch = global.fetch;
  const originalRetries = process.env.SKILLS_MAX_PROVIDER_RETRIES;

  beforeEach(() => {
    process.env.SKILLS_MAX_PROVIDER_RETRIES = '0';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.SKILLS_MAX_PROVIDER_RETRIES = originalRetries;
  });

  test('maps invoke request to skill.id + run_context + limits.timeout_seconds', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {
        job_id: 'job_123',
        status: 'queued',
        outputs: { ok: true },
        artifacts: []
      });
    });

    const adapter = new HttpWorkerAdapter('http://worker.local');
    await adapter.invoke({
      skill_key: 'seo_audit',
      skill_version: '1.0.0',
      workspace_id: 42,
      inputs: { target: 'example.com' },
      context_data: { workflow_run_id: 'wr_123', workflow_step_id: 'wrs_55', task_id: 901 },
      timeout_ms: 600000,
      idempotency_key: 'user:user:17:key_abc',
      actor: { type: 'user', id: 'user:17' },
      invocation_id: '55'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://worker.local/v1/jobs');
    const body = JSON.parse(calls[0].options.body);
    expect(body).toMatchObject({
      request_id: 'user:user:17:key_abc',
      workspace_id: 42,
      run_context: {
        workflow_run_id: 'wr_123',
        workflow_step_id: 'wrs_55',
        task_id: 901,
        trigger_source: 'engine',
        triggered_by: 'user:17'
      },
      skill: { id: 'seo_audit', version: '1.0.0' },
      inputs: { target: 'example.com' },
      idempotency_key: 'user:user:17:key_abc'
    });
    expect(body.limits).toEqual({ timeout_seconds: 600 });
  });

  test('invoke requires job_id in response', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, { status: 'queued' }));
    const adapter = new HttpWorkerAdapter('http://worker.local');
    await expect(adapter.invoke({ skill_key: 'seo', inputs: {} })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR'
    });
  });

  test('getInvocation requires job_id + known status', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, { job_id: 'job_abc', status: 'running', outputs: { progress: 30 } }));
    const adapter = new HttpWorkerAdapter('http://worker.local');
    const result = await adapter.getInvocation('job_abc');
    expect(result).toMatchObject({
      invocationId: 'job_abc',
      status: 'running',
      output: { progress: 30 }
    });
  });

  test('catalog uses /v1/skills and maps skill.id -> key', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {
        skills: [
          { id: 'seo_audit', name: 'SEO Audit', description: '...', version: '1.0.0', input_schema: {}, metadata: { team: 'growth' } }
        ]
      });
    });
    const adapter = new HttpWorkerAdapter('http://worker.local');
    const result = await adapter.listSkills();

    expect(calls[0].url).toBe('http://worker.local/v1/skills');
    expect(result.skills[0]).toMatchObject({
      key: 'seo_audit',
      name: 'SEO Audit',
      version: '1.0.0'
    });
  });

  test('catalog fails when skills[] missing', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, { items: [] }));
    const adapter = new HttpWorkerAdapter('http://worker.local');
    await expect(adapter.listSkills()).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR'
    });
  });

  test('catalog fails when skill id is missing', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, { skills: [{ name: 'No Id' }] }));
    const adapter = new HttpWorkerAdapter('http://worker.local');
    await expect(adapter.listSkills()).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR'
    });
  });

  test('health calls /healthz', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { ok: true, worker: 'up' });
    });
    const adapter = new HttpWorkerAdapter('http://worker.local');
    const result = await adapter.health();

    expect(calls[0].url).toBe('http://worker.local/healthz');
    expect(result.ok).toBe(true);
    expect(result.details.worker).toBe('up');
  });

  test('non-JSON worker payload fails closed', async () => {
    global.fetch = jest.fn(async () => new Response('not-json', { status: 200 }));
    const adapter = new HttpWorkerAdapter('http://worker.local');
    await expect(adapter.getInvocation('job_123')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR'
    });
  });

  test('unknown status fails closed', async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, { job_id: 'job_123', status: 'mystery' }));
    const adapter = new HttpWorkerAdapter('http://worker.local');
    await expect(adapter.getInvocation('job_123')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR'
    });
  });
});
