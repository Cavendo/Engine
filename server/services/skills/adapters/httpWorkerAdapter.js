import crypto from 'crypto';
import { SkillsAdapter } from './base.js';
import { SKILLS_ERROR_CODES, normalizeWorkerStatus } from '../types.js';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.SKILLS_WORKER_REQUEST_TIMEOUT_MS || '15000', 10);
const DEFAULT_RETRIES = parseInt(process.env.SKILLS_MAX_PROVIDER_RETRIES || '2', 10);
const JOBS_BASE = '/v1/jobs';
const CATALOG_PATH = '/v1/skills';
const HEALTH_PATH = '/healthz';

function createError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, 'Worker returned non-JSON response', {
      status: response.status
    });
  }
}

function signHeaders(body) {
  const headers = {
    'Content-Type': 'application/json'
  };

  const bearer = process.env.SKILLS_WORKER_BEARER_TOKEN;
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }

  const secret = process.env.SKILLS_WORKER_HMAC_SECRET;
  if (secret) {
    const timestamp = new Date().toISOString();
    const payload = `${timestamp}.${body}`;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    headers['X-Skills-Timestamp'] = timestamp;
    headers['X-Skills-Signature'] = signature;
  }

  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw createError(SKILLS_ERROR_CODES.PROVIDER_UNAVAILABLE, 'Worker request timed out');
    }
    throw createError(SKILLS_ERROR_CODES.PROVIDER_UNAVAILABLE, `Worker request failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRunContext(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const allowed = ['workflow_run_id', 'workflow_step_id', 'task_id', 'trigger_source', 'triggered_by'];
  const output = {};
  for (const key of allowed) {
    if (input[key] !== undefined && input[key] !== null) output[key] = input[key];
  }
  return output;
}

function isObjectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapInvokePayloadToWorker(payload = {}) {
  const contextData = payload.context_data && typeof payload.context_data === 'object' && !Array.isArray(payload.context_data)
    ? payload.context_data
    : {};

  const defaults = {
    workflow_run_id: payload.workflow_run_id ?? contextData.workflow_run_id,
    workflow_step_id: payload.workflow_step_id ?? contextData.workflow_step_id,
    task_id: payload.task_id ?? contextData.task_id,
    trigger_source: 'engine',
    triggered_by: payload.actor?.id || contextData.triggered_by
  };

  const runContext = {
    ...normalizeRunContext(contextData),
    ...normalizeRunContext(defaults)
  };

  const timeoutMs = Number(payload.timeout_ms || 0);
  const timeoutSeconds = timeoutMs > 0 ? Math.max(1, Math.round(timeoutMs / 1000)) : undefined;

  const body = {
    request_id: payload.idempotency_key || payload.invocation_id || `req_${Date.now()}`,
    workspace_id: payload.workspace_id ?? null,
    run_context: runContext,
    skill: {
      id: payload.skill_key,
      version: payload.skill_version || undefined
    },
    inputs: payload.inputs || {},
    idempotency_key: payload.idempotency_key
  };

  if (isObjectLike(payload.connector_bindings)) {
    body.connector_bindings = payload.connector_bindings;
  }

  if (timeoutSeconds) {
    body.limits = { timeout_seconds: timeoutSeconds };
  }

  return body;
}

function parseWorkerJobResponse(data, contextLabel) {
  if (typeof data.job_id !== 'string' || !data.job_id.trim()) {
    throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, `${contextLabel} missing job_id`);
  }
  const status = normalizeWorkerStatus(data.status);
  if (!status) {
    throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, `Unknown worker status: ${data.status}`);
  }

  return {
    invocationId: data.job_id,
    status,
    output: data.outputs || null,
    artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
    error: data.error || null,
    cost: data.cost || null
  };
}

export class HttpWorkerAdapter extends SkillsAdapter {
  constructor(baseUrl = process.env.SKILLS_WORKER_BASE_URL) {
    super();
    if (!baseUrl) {
      throw createError(SKILLS_ERROR_CODES.PROVIDER_UNAVAILABLE, 'SKILLS_WORKER_BASE_URL is required');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async request(path, payload, { retries = DEFAULT_RETRIES, method = 'POST' } = {}) {
    const url = `${this.baseUrl}${path}`;
    const body = payload ? JSON.stringify(payload) : '';
    const headers = signHeaders(body);

    let attempt = 0;
    while (true) {
      attempt += 1;
      const response = await fetchWithTimeout(url, { method, headers, body: method === 'GET' ? undefined : body });

      if (response.ok) {
        return parseJsonResponse(response);
      }

      const data = await parseJsonResponse(response).catch(() => ({}));
      const message = data.error?.message || data.message || `Worker error HTTP ${response.status}`;

      if (response.status === 404) {
        throw createError(SKILLS_ERROR_CODES.SKILL_NOT_FOUND, message, { status: response.status });
      }
      if (response.status >= 400 && response.status < 500) {
        throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, message, { status: response.status });
      }

      if (attempt > retries) {
        throw createError(SKILLS_ERROR_CODES.PROVIDER_UNAVAILABLE, message, { status: response.status, attempts: attempt });
      }
    }
  }

  async listSkills() {
    const data = await this.request(CATALOG_PATH, null, { method: 'GET' });
    if (!Array.isArray(data.skills)) {
      throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, 'Worker catalog missing skills[]');
    }

    const skills = data.skills.map((s) => {
      if (!s || typeof s !== 'object') {
        throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, 'Worker catalog skill entry malformed');
      }
      if (typeof s.id !== 'string' || !s.id.trim()) {
        throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, 'Worker catalog skill missing id');
      }
      if (s.input_schema != null && (typeof s.input_schema !== 'object' || Array.isArray(s.input_schema))) {
        throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, `Skill ${s.id} input_schema must be an object`);
      }
      return {
        key: s.id,
        name: typeof s.name === 'string' ? s.name : s.id,
        description: typeof s.description === 'string' ? s.description : '',
        version: typeof s.version === 'string' ? s.version : null,
        input_schema: s.input_schema || null,
        metadata: isObjectLike(s.metadata) ? s.metadata : {},
        dependencies: isObjectLike(s.dependencies) ? s.dependencies : null,
        runtime: isObjectLike(s.runtime) ? s.runtime : null,
        output_policy: isObjectLike(s.output_policy) ? s.output_policy : null
      };
    });

    return { skills };
  }

  async invoke(request) {
    const payload = mapInvokePayloadToWorker(request);
    const data = await this.request(JOBS_BASE, payload, { method: 'POST' });
    return parseWorkerJobResponse(data, 'Invoke response');
  }

  async getInvocation(invocationId) {
    const data = await this.request(`${JOBS_BASE}/${encodeURIComponent(invocationId)}`, null, { method: 'GET' });
    return parseWorkerJobResponse(data, 'Invocation response');
  }

  async cancelInvocation(invocationId) {
    const data = await this.request(`${JOBS_BASE}/${encodeURIComponent(invocationId)}/cancel`, {}, { method: 'POST' });
    if (typeof data.job_id !== 'string' || !data.job_id.trim()) {
      throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, 'Cancel response missing job_id');
    }
    const status = normalizeWorkerStatus(data.status);
    if (!status) {
      throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, `Unknown worker cancel status: ${data.status}`);
    }
    return { status };
  }

  async health() {
    const data = await this.request(HEALTH_PATH, null, { method: 'GET', retries: 0 });
    return {
      provider: 'http_worker',
      ok: Boolean(data.ok),
      details: data
    };
  }
}

let singletonAdapter;

export function getSkillsAdapter() {
  const provider = process.env.SKILLS_PROVIDER || 'http_worker';
  if (provider !== 'http_worker') {
    throw createError(SKILLS_ERROR_CODES.PROVIDER_UNAVAILABLE, `Unsupported skills provider: ${provider}`);
  }

  if (!singletonAdapter) {
    singletonAdapter = new HttpWorkerAdapter();
  }
  return singletonAdapter;
}
