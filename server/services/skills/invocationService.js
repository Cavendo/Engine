import db from '../../db/adapter.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSkillsAdapter } from './adapters/httpWorkerAdapter.js';
import {
  SKILLS_ERROR_CODES,
  SKILLS_STATUSES,
  canTransitionStatus,
  TERMINAL_SKILLS_STATUSES
} from './types.js';
import { assertInvokeAllowed, getEffectiveRole, getSkillFromCatalog } from './catalogService.js';

const POLL_INTERVAL_MS = parseInt(process.env.SKILLS_POLL_INTERVAL_MS || '5000', 10);
const POLL_LEASE_SECONDS = parseInt(process.env.SKILLS_POLL_LEASE_SECONDS || '30', 10);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CONTEXT_BYTES = parseInt(process.env.SKILLS_MAX_CONTEXT_BYTES || '65536', 10);
const MAX_OUTPUT_BYTES = parseInt(process.env.SKILLS_MAX_OUTPUT_BYTES || '262144', 10);
const MAX_INPUT_BYTES = parseInt(process.env.SKILLS_MAX_INPUT_BYTES || '262144', 10);

function nowIso() {
  return new Date().toISOString();
}

function addMs(iso, ms) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function byteSize(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value || {}), 'utf8');
}

function createError(code, message, status = 400, details = null) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (details !== null) err.details = details;
  return err;
}

function normalizeInvocationRow(row) {
  return {
    ...row,
    input_json: parseJsonField(row.input_json, {}),
    context_json: parseJsonField(row.context_json, {}),
    output_json: parseJsonField(row.output_json, null),
    error_detail_json: parseJsonField(row.error_detail_json, null),
    cancel_request_error_json: parseJsonField(row.cancel_request_error_json, null),
    cost_units: row.cost_units == null ? null : Number(row.cost_units)
  };
}

async function loadArtifacts(invocationId) {
  const rows = await db.many(
    'SELECT id, skill_invocation_id, artifact_type, uri, metadata_json, created_at FROM skill_invocation_artifacts WHERE skill_invocation_id = ? ORDER BY id ASC',
    [invocationId]
  );
  return rows.map((r) => ({
    ...r,
    metadata_json: parseJsonField(r.metadata_json, {})
  }));
}

function validateActor(auth) {
  if (!auth?.actorType || !auth?.actorId) {
    throw createError(SKILLS_ERROR_CODES.POLICY_DENIED, 'Missing auth actor context', 403);
  }
  if (auth.actorType === 'user' && !/^user:\d+$/.test(auth.actorId)) {
    throw createError(SKILLS_ERROR_CODES.POLICY_DENIED, 'Invalid user actor identifier', 403);
  }
  if (auth.actorType === 'system' && !/^system:[a-z0-9][a-z0-9_-]{1,63}$/.test(auth.actorId)) {
    throw createError(SKILLS_ERROR_CODES.POLICY_DENIED, 'Invalid system actor identifier', 403);
  }
}

function validateSimpleSchema(inputSchema, value, path = 'inputs') {
  if (!inputSchema || typeof inputSchema !== 'object') return;
  if (inputSchema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, `${path} must be an object`, 422);
    }
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, `${path}.${key} is required`, 422);
      }
    }
    const props = inputSchema.properties && typeof inputSchema.properties === 'object' ? inputSchema.properties : {};
    for (const [k, schema] of Object.entries(props)) {
      if (!(k in value)) continue;
      validateSimpleSchema(schema, value[k], `${path}.${k}`);
    }
    return;
  }
  if (inputSchema.type === 'array') {
    if (!Array.isArray(value)) {
      throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, `${path} must be an array`, 422);
    }
    if (inputSchema.items) {
      for (let i = 0; i < value.length; i++) {
        validateSimpleSchema(inputSchema.items, value[i], `${path}[${i}]`);
      }
    }
    return;
  }
  if (inputSchema.type === 'string' && typeof value !== 'string') {
    throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, `${path} must be a string`, 422);
  }
  if (inputSchema.type === 'number' && typeof value !== 'number') {
    throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, `${path} must be a number`, 422);
  }
  if (inputSchema.type === 'integer' && (!Number.isInteger(value))) {
    throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, `${path} must be an integer`, 422);
  }
  if (inputSchema.type === 'boolean' && typeof value !== 'boolean') {
    throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, `${path} must be a boolean`, 422);
  }
  if (Array.isArray(inputSchema.enum) && !inputSchema.enum.includes(value)) {
    throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, `${path} must be one of: ${inputSchema.enum.join(', ')}`, 422);
  }
}

function summarizeOutput(output) {
  if (output == null) return null;
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  if (Buffer.byteLength(raw, 'utf8') <= MAX_OUTPUT_BYTES) {
    return typeof output === 'string' ? { text: output } : output;
  }
  const truncated = raw.slice(0, MAX_OUTPUT_BYTES);
  return {
    truncated: true,
    bytes: Buffer.byteLength(raw, 'utf8'),
    preview: truncated
  };
}

function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .filter((a) => a && typeof a === 'object' && typeof a.uri === 'string' && a.uri.trim())
    .map((a) => ({
      artifact_type: typeof a.artifact_type === 'string' ? a.artifact_type : 'unknown',
      uri: a.uri,
      metadata_json: a.metadata && typeof a.metadata === 'object' && !Array.isArray(a.metadata) ? a.metadata : {}
    }));
}

async function replaceArtifacts(tx, invocationId, artifacts) {
  await tx.exec('DELETE FROM skill_invocation_artifacts WHERE skill_invocation_id = ?', [invocationId]);
  for (const artifact of artifacts) {
    await tx.insert(
      'INSERT INTO skill_invocation_artifacts (skill_invocation_id, artifact_type, uri, metadata_json) VALUES (?, ?, ?, ?)',
      [invocationId, artifact.artifact_type, artifact.uri, JSON.stringify(artifact.metadata_json || {})]
    );
  }
}

export async function getInvocationById(id, auth) {
  validateActor(auth);

  const row = await db.one('SELECT * FROM skill_invocations WHERE id = ?', [id]);
  if (!row) {
    throw createError(SKILLS_ERROR_CODES.SKILL_NOT_FOUND, 'Invocation not found', 404);
  }

  if (auth.actorType !== 'system' && row.actor_id !== auth.actorId) {
    throw createError(SKILLS_ERROR_CODES.POLICY_DENIED, 'Invocation is not accessible', 403);
  }

  const normalized = normalizeInvocationRow(row);
  const artifacts = await loadArtifacts(id);
  return {
    ...normalized,
    artifacts
  };
}

export async function createInvocation(payload, { auth, user }) {
  validateActor(auth);

  const inputBytes = byteSize(payload.inputs || {});
  const contextBytes = byteSize(payload.contextData || {});
  if (inputBytes > MAX_INPUT_BYTES) {
    throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, 'inputs exceeds maximum size', 422);
  }
  if (contextBytes > MAX_CONTEXT_BYTES) {
    throw createError(SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED, 'contextData exceeds maximum size', 422);
  }

  const existing = await db.one(
    'SELECT id FROM skill_invocations WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?',
    [auth.actorType, auth.actorId, payload.idempotencyKey]
  );
  if (existing) {
    return getInvocationById(existing.id, auth);
  }

  const role = getEffectiveRole(auth, user);
  await assertInvokeAllowed(payload.skillKey, role, payload.workspaceId || null);

  const skill = await getSkillFromCatalog(payload.skillKey);
  validateSimpleSchema(skill.input_schema, payload.inputs || {}, 'inputs');

  const createdAt = nowIso();
  const timeoutMs = Math.max(5000, Number(payload.timeoutMs || DEFAULT_TIMEOUT_MS));
  const timeoutAt = addMs(createdAt, timeoutMs);
  const nextPollAt = addMs(createdAt, POLL_INTERVAL_MS);

  const adapter = getSkillsAdapter();

  let invocationId;
  try {
    invocationId = await db.tx(async (tx) => {
      const insert = await tx.insert(`
      INSERT INTO skill_invocations (
        actor_type, actor_id, workspace_id, task_id, workflow_run_id, workflow_step_id,
        provider, skill_key, skill_version, input_json, context_json, output_json,
        status, external_invocation_id, error_code, error_message, error_detail_json,
        queued_at, started_at, completed_at, timed_out_at, cancelled_at,
        cancel_requested_at, cancel_request_error_json,
        last_polled_at, next_poll_at, timeout_at,
        poll_claimed_by, poll_claimed_until,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      auth.actorType,
      auth.actorId,
      payload.workspaceId || null,
      payload.taskId || null,
      payload.workflowRunId || null,
      payload.workflowStepId || null,
      process.env.SKILLS_PROVIDER || 'http_worker',
      payload.skillKey,
      skill.version || null,
      JSON.stringify(payload.inputs || {}),
      JSON.stringify(payload.contextData || {}),
      null,
      SKILLS_STATUSES.QUEUED,
      null,
      null,
      null,
      null,
      createdAt,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      nextPollAt,
      timeoutAt,
      null,
      null,
      payload.idempotencyKey,
      createdAt,
      createdAt
    ]);

      return insert.lastInsertRowid;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const collision = await db.one(
        'SELECT id FROM skill_invocations WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?',
        [auth.actorType, auth.actorId, payload.idempotencyKey]
      );
      if (collision?.id) {
        return getInvocationById(collision.id, auth);
      }
    }
    throw err;
  }

  try {
    const invokeResult = await adapter.invoke({
      skill_key: payload.skillKey,
      skill_version: skill.version || null,
      inputs: payload.inputs || {},
      context_data: payload.contextData || {},
      workspace_id: payload.workspaceId || null,
      workflow_run_id: payload.workflowRunId || null,
      workflow_step_id: payload.workflowStepId || null,
      task_id: payload.taskId || null,
      timeout_ms: timeoutMs,
      idempotency_key: `${auth.actorType}:${auth.actorId}:${payload.idempotencyKey}`,
      actor: {
        type: auth.actorType,
        id: auth.actorId
      },
      invocation_id: String(invocationId)
    });

    await db.tx(async (tx) => {
      const startedAt = [SKILLS_STATUSES.RUNNING, SKILLS_STATUSES.COMPLETED].includes(invokeResult.status) ? nowIso() : null;
      await tx.exec(`
        UPDATE skill_invocations
        SET status = ?,
            external_invocation_id = ?,
            started_at = COALESCE(started_at, ?),
            output_json = ?,
            updated_at = ?,
            next_poll_at = ?
        WHERE id = ?
      `, [
        invokeResult.status,
        invokeResult.invocationId,
        startedAt,
        JSON.stringify(summarizeOutput(invokeResult.output)),
        nowIso(),
        addMs(nowIso(), POLL_INTERVAL_MS),
        invocationId
      ]);

      if (TERMINAL_SKILLS_STATUSES.has(invokeResult.status)) {
        const terminalTime = nowIso();
        const updates = [];
        const values = [];
        if (invokeResult.status === SKILLS_STATUSES.COMPLETED) {
          updates.push('completed_at = ?');
          values.push(terminalTime);
        } else if (invokeResult.status === SKILLS_STATUSES.CANCELLED) {
          updates.push('cancelled_at = ?');
          values.push(terminalTime);
        } else if (invokeResult.status === SKILLS_STATUSES.TIMED_OUT) {
          updates.push('timed_out_at = ?');
          values.push(terminalTime);
        }
        if (invokeResult.error) {
          updates.push('error_code = ?', 'error_message = ?', 'error_detail_json = ?');
          values.push(
            invokeResult.error.code || SKILLS_ERROR_CODES.UPSTREAM_ERROR,
            invokeResult.error.message || 'Worker reported error',
            JSON.stringify(invokeResult.error)
          );
        }
        updates.push('updated_at = ?');
        values.push(terminalTime);
        values.push(invocationId);
        await tx.exec(`UPDATE skill_invocations SET ${updates.join(', ')} WHERE id = ?`, values);
      }

      const artifacts = normalizeArtifacts(invokeResult.artifacts);
      if (artifacts.length > 0) {
        await replaceArtifacts(tx, invocationId, artifacts);
      }
    });
  } catch (err) {
    const code = err.code || SKILLS_ERROR_CODES.PROVIDER_UNAVAILABLE;
    await db.exec(`
      UPDATE skill_invocations
      SET status = ?,
          error_code = ?,
          error_message = ?,
          error_detail_json = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      SKILLS_STATUSES.FAILED,
      code,
      err.message,
      JSON.stringify(err.details || {}),
      nowIso(),
      invocationId
    ]);
  }

  return getInvocationById(invocationId, auth);
}

export async function cancelInvocation(id, auth) {
  validateActor(auth);

  const invocation = await db.one('SELECT * FROM skill_invocations WHERE id = ?', [id]);
  if (!invocation) {
    throw createError(SKILLS_ERROR_CODES.SKILL_NOT_FOUND, 'Invocation not found', 404);
  }
  if (auth.actorType !== 'system' && invocation.actor_id !== auth.actorId) {
    throw createError(SKILLS_ERROR_CODES.POLICY_DENIED, 'Invocation is not accessible', 403);
  }

  if (![SKILLS_STATUSES.QUEUED, SKILLS_STATUSES.RUNNING].includes(invocation.status)) {
    return getInvocationById(id, auth);
  }

  await db.exec('UPDATE skill_invocations SET cancel_requested_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), id]);

  const adapter = getSkillsAdapter();
  try {
    if (invocation.external_invocation_id) {
      const result = await adapter.cancelInvocation(invocation.external_invocation_id);
      const targetStatus = result.status === SKILLS_STATUSES.CANCELLED ? SKILLS_STATUSES.CANCELLED : invocation.status;
      if (targetStatus === SKILLS_STATUSES.CANCELLED && canTransitionStatus(invocation.status, SKILLS_STATUSES.CANCELLED)) {
        await db.exec(`
          UPDATE skill_invocations
          SET status = ?, cancelled_at = ?, error_code = ?, error_message = ?, updated_at = ?
          WHERE id = ?
        `, [SKILLS_STATUSES.CANCELLED, nowIso(), SKILLS_ERROR_CODES.CANCELLED, 'Cancelled', nowIso(), id]);
      }
    } else if (canTransitionStatus(invocation.status, SKILLS_STATUSES.CANCELLED)) {
      await db.exec(`
        UPDATE skill_invocations
        SET status = ?, cancelled_at = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `, [SKILLS_STATUSES.CANCELLED, nowIso(), SKILLS_ERROR_CODES.CANCELLED, 'Cancelled', nowIso(), id]);
    }
  } catch (err) {
    await db.exec(
      'UPDATE skill_invocations SET cancel_request_error_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify({ code: err.code || SKILLS_ERROR_CODES.UPSTREAM_ERROR, message: err.message }), nowIso(), id]
    );
    throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, `Cancel request failed: ${err.message}`, 503);
  }

  return getInvocationById(id, auth);
}

export async function claimDueInvocations(ownerId, limit = 20) {
  const now = nowIso();
  const claimedUntil = addMs(now, POLL_LEASE_SECONDS * 1000);

  if (db.dialect === 'postgres') {
    const rows = await db.many(`
      WITH candidates AS (
        SELECT id
        FROM skill_invocations
        WHERE status IN ('queued', 'running')
          AND next_poll_at <= ?
          AND (poll_claimed_until IS NULL OR poll_claimed_until < ?)
        ORDER BY next_poll_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ?
      )
      UPDATE skill_invocations s
      SET poll_claimed_by = ?,
          poll_claimed_until = ?,
          updated_at = ?
      FROM candidates c
      WHERE s.id = c.id
      RETURNING s.*
    `, [now, now, limit, ownerId, claimedUntil, now]);
    return rows.map(normalizeInvocationRow);
  }

  return db.tx(async (tx) => {
    const candidates = await tx.many(`
      SELECT *
      FROM skill_invocations
      WHERE status IN ('queued', 'running')
        AND next_poll_at <= ?
        AND (poll_claimed_until IS NULL OR poll_claimed_until < ?)
      ORDER BY next_poll_at ASC
      LIMIT ?
    `, [now, now, limit]);

    const claimed = [];
    for (const candidate of candidates) {
      const result = await tx.exec(`
        UPDATE skill_invocations
        SET poll_claimed_by = ?, poll_claimed_until = ?, updated_at = ?
        WHERE id = ?
          AND (poll_claimed_until IS NULL OR poll_claimed_until < ?)
      `, [ownerId, claimedUntil, now, candidate.id, now]);
      if (result.changes > 0) {
        claimed.push({ ...candidate, poll_claimed_by: ownerId, poll_claimed_until: claimedUntil });
      }
    }

    return claimed.map(normalizeInvocationRow);
  });
}

export async function releaseClaim(id, ownerId) {
  await db.exec(
    'UPDATE skill_invocations SET poll_claimed_by = NULL, poll_claimed_until = NULL, updated_at = ? WHERE id = ? AND poll_claimed_by = ?',
    [nowIso(), id, ownerId]
  );
}

export async function processClaimedInvocation(invocation, ownerId) {
  const adapter = getSkillsAdapter();
  const now = nowIso();

  if (TERMINAL_SKILLS_STATUSES.has(invocation.status)) {
    await releaseClaim(invocation.id, ownerId);
    return;
  }

  if (invocation.timeout_at && new Date(invocation.timeout_at).getTime() <= Date.now()) {
    if (canTransitionStatus(invocation.status, SKILLS_STATUSES.TIMED_OUT)) {
      await db.exec(`
        UPDATE skill_invocations
        SET status = ?, error_code = ?, error_message = ?, timed_out_at = ?,
            poll_claimed_by = NULL, poll_claimed_until = NULL, updated_at = ?
        WHERE id = ? AND poll_claimed_by = ?
      `, [
        SKILLS_STATUSES.TIMED_OUT,
        SKILLS_ERROR_CODES.TIMEOUT,
        'Invocation timed out',
        now,
        now,
        invocation.id,
        ownerId
      ]);
    } else {
      await releaseClaim(invocation.id, ownerId);
    }
    return;
  }

  if (!invocation.external_invocation_id) {
    await db.exec(
      'UPDATE skill_invocations SET next_poll_at = ?, poll_claimed_by = NULL, poll_claimed_until = NULL, updated_at = ? WHERE id = ? AND poll_claimed_by = ?',
      [addMs(now, POLL_INTERVAL_MS), now, invocation.id, ownerId]
    );
    return;
  }

  try {
    const result = await adapter.getInvocation(invocation.external_invocation_id);
    if (!canTransitionStatus(invocation.status, result.status) && invocation.status !== result.status) {
      throw createError(SKILLS_ERROR_CODES.UPSTREAM_ERROR, `Invalid status transition ${invocation.status} -> ${result.status}`);
    }

    await db.tx(async (tx) => {
      const updates = ['status = ?', 'last_polled_at = ?', 'next_poll_at = ?', 'output_json = ?', 'updated_at = ?'];
      const values = [
        result.status,
        now,
        addMs(now, POLL_INTERVAL_MS),
        JSON.stringify(summarizeOutput(result.output)),
        now
      ];

      if (result.status === SKILLS_STATUSES.RUNNING && !invocation.started_at) {
        updates.push('started_at = ?');
        values.push(now);
      }

      if (result.status === SKILLS_STATUSES.COMPLETED) {
        updates.push('completed_at = ?');
        values.push(now);
      }
      if (result.status === SKILLS_STATUSES.CANCELLED) {
        updates.push('cancelled_at = ?', 'error_code = ?', 'error_message = ?');
        values.push(now, SKILLS_ERROR_CODES.CANCELLED, 'Cancelled');
      }
      if (result.status === SKILLS_STATUSES.FAILED) {
        updates.push('error_code = ?', 'error_message = ?', 'error_detail_json = ?');
        values.push(
          result.error?.code || SKILLS_ERROR_CODES.UPSTREAM_ERROR,
          result.error?.message || 'Invocation failed',
          JSON.stringify(result.error || {})
        );
      }
      if (result.status === SKILLS_STATUSES.TIMED_OUT) {
        updates.push('timed_out_at = ?', 'error_code = ?', 'error_message = ?');
        values.push(now, SKILLS_ERROR_CODES.TIMEOUT, 'Timed out');
      }

      if (TERMINAL_SKILLS_STATUSES.has(result.status)) {
        updates.push('poll_claimed_by = NULL', 'poll_claimed_until = NULL');
      } else {
        updates.push('poll_claimed_until = ?');
        values.push(addMs(now, POLL_LEASE_SECONDS * 1000));
      }

      values.push(invocation.id, ownerId);
      await tx.exec(`
        UPDATE skill_invocations
        SET ${updates.join(', ')}
        WHERE id = ? AND poll_claimed_by = ?
      `, values);

      if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
        await replaceArtifacts(tx, invocation.id, normalizeArtifacts(result.artifacts));
      }
    });
  } catch (err) {
    await db.exec(`
      UPDATE skill_invocations
      SET last_polled_at = ?,
          next_poll_at = ?,
          error_code = COALESCE(error_code, ?),
          error_message = COALESCE(error_message, ?),
          error_detail_json = ?,
          poll_claimed_by = NULL,
          poll_claimed_until = NULL,
          updated_at = ?
      WHERE id = ? AND poll_claimed_by = ?
    `, [
      now,
      addMs(now, POLL_INTERVAL_MS),
      err.code || SKILLS_ERROR_CODES.UPSTREAM_ERROR,
      err.message,
      JSON.stringify(err.details || {}),
      now,
      invocation.id,
      ownerId
    ]);
  }
}

export async function getHealthSnapshot() {
  let adapterHealth;
  try {
    const adapter = getSkillsAdapter();
    adapterHealth = await adapter.health();
  } catch (err) {
    adapterHealth = {
      provider: process.env.SKILLS_PROVIDER || 'http_worker',
      ok: false,
      error: err.message,
      code: err.code || SKILLS_ERROR_CODES.PROVIDER_UNAVAILABLE
    };
  }
  const statusRows = await db.many(`
    SELECT status, COUNT(*) AS count
    FROM skill_invocations
    GROUP BY status
  `);

  const byStatus = {};
  for (const row of statusRows) {
    byStatus[row.status] = Number(row.count);
  }

  return {
    provider: process.env.SKILLS_PROVIDER || 'http_worker',
    pollIntervalMs: POLL_INTERVAL_MS,
    leaseSeconds: POLL_LEASE_SECONDS,
    limits: {
      maxContextBytes: MAX_CONTEXT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxInputBytes: MAX_INPUT_BYTES
    },
    counts: byStatus,
    adapter: adapterHealth
  };
}
