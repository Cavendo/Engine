import { Router } from 'express';
import db from '../db/adapter.js';
import { generateApiKey, generateWebhookSecret, encrypt, decrypt } from '../utils/crypto.js';
import * as response from '../utils/response.js';
import { requireUserOrUserKeyRoles } from '../middleware/userAuth.js';
import { agentAuth, dualAuth } from '../middleware/agentAuth.js';
import { keyGenLimiter } from '../middleware/security.js';
import { dispatchEvent } from '../services/routeDispatcher.js';
import {
  validateBody,
  createAgentSchema,
  updateAgentSchema,
  generateKeySchema,
  matchAgentsSchema,
  updateAgentOwnerSchema,
  updateAgentExecutionSchema,
  claimTaskLeaseSchema,
  taskLeaseHeartbeatSchema,
  releaseTaskLeaseSchema
} from '../utils/validation.js';
import { validateProviderBaseUrl, resolveBaseUrl } from '../utils/providerEndpoint.js';
import {
  toISOTimestamp as formatTimestamp,
  dateBucketExpression,
  normalizeDateBucket
} from '../utils/routeHelpers.js';

const router = Router();

async function requireScopedAgent(req, res, agentId) {
  const requestedAgentId = Number.parseInt(agentId, 10);
  if (!Number.isInteger(requestedAgentId) || requestedAgentId <= 0) {
    response.validationError(res, 'Invalid agent ID');
    return null;
  }

  if (req.user || req.agent?.isUserKey) {
    return { scoped: false, agentId: requestedAgentId };
  }

  if (req.agent?.id && Number(req.agent.id) === requestedAgentId) {
    return { scoped: true, agentId: requestedAgentId };
  }

  response.forbidden(res, 'Access denied');
  return null;
}

/**
 * Convert SQLite timestamp to ISO 8601 format
 * SQLite returns "YYYY-MM-DD HH:MM:SS" but JS needs "YYYY-MM-DDTHH:MM:SS.000Z"
 */
function toISOTimestamp(timestamp) {
  return formatTimestamp(timestamp);
}

function agentDateBucket(column) {
  return dateBucketExpression(column, db.dialect);
}

function hasRunnableProviderSetup(agent) {
  const provider = String(agent?.provider || '').trim().toLowerCase();
  if (!provider) return false;
  return provider === 'openai_compatible' || Boolean(agent?.provider_api_key_encrypted);
}

/**
 * Normalize timestamp fields on an agent object
 */
function safeJsonParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val; // already parsed
  try { return JSON.parse(val); } catch { return fallback; }
}

function normalizeAgentTimestamps(agent) {
  const { provider_api_key_encrypted, provider_api_key_iv, ...safe } = agent;
  return {
    ...safe,
    capabilities: safeJsonParse(agent.capabilities, []),
    specializations: safeJsonParse(agent.specializations, {}),
    metadata: safeJsonParse(agent.metadata, {}),
    webhook_events: safeJsonParse(agent.webhook_events, []),
    project_access: safeJsonParse(agent.project_access, ['*']),
    task_types: safeJsonParse(agent.task_types, ['*']),
    has_api_key: !!(provider_api_key_encrypted),
    has_runnable_provider_setup: hasRunnableProviderSetup(agent),
    provider_base_url: agent.provider_base_url || null,
    provider_label: agent.provider_label || null,
    created_at: toISOTimestamp(agent.created_at),
    updated_at: toISOTimestamp(agent.updated_at)
  };
}

/**
 * Normalize timestamp fields on an agent key object
 */
function normalizeKeyTimestamps(key) {
  return {
    ...key,
    created_at: toISOTimestamp(key.created_at),
    last_used_at: toISOTimestamp(key.last_used_at),
    expires_at: toISOTimestamp(key.expires_at),
    revoked_at: toISOTimestamp(key.revoked_at)
  };
}

/**
 * Normalize timestamp fields on a task object (for agent task endpoints)
 */
function normalizeTaskTimestamps(task) {
  return {
    ...task,
    context: safeJsonParse(task.context, {}),
    tags: safeJsonParse(task.tags, []),
    required_capabilities: safeJsonParse(task.required_capabilities, []),
    created_at: toISOTimestamp(task.created_at),
    updated_at: toISOTimestamp(task.updated_at),
    due_date: toISOTimestamp(task.due_date),
    completed_at: toISOTimestamp(task.completed_at),
    assigned_at: toISOTimestamp(task.assigned_at),
    started_at: toISOTimestamp(task.started_at),
    agent_claimed_at: toISOTimestamp(task.agent_claimed_at),
    agent_claim_expires_at: toISOTimestamp(task.agent_claim_expires_at),
    agent_last_heartbeat_at: toISOTimestamp(task.agent_last_heartbeat_at)
  };
}

/**
 * Parse all JSON fields on an agent object
 */
function parseAgentJsonFields(agent) {
  return {
    ...agent,
    capabilities: safeJsonParse(agent.capabilities, []),
    specializations: safeJsonParse(agent.specializations, {}),
    metadata: safeJsonParse(agent.metadata, {}),
    webhook_events: safeJsonParse(agent.webhook_events, []),
    project_access: safeJsonParse(agent.project_access, ['*']),
    task_types: safeJsonParse(agent.task_types, ['*'])
  };
}

function normalizeAgentProjectAccessForSync(rawProjectAccess) {
  if (Array.isArray(rawProjectAccess)) {
    const values = rawProjectAccess.map((entry) => String(entry || '').trim()).filter(Boolean);
    if (values.length === 0) return ['*'];
    if (values.some((entry) => entry === '*')) return ['*'];
    return Array.from(new Set(values));
  }
  return ['*'];
}

async function assertRuntimeLockAllowed() {
  return null;
}

function normalizeRuntimeLockPayload(value) {
  const raw = value && typeof value === 'object' ? value : null;
  if (!raw) return null;
  const primaryProvider = String(raw.primaryProvider || raw.primary_provider || '').trim().toLowerCase();
  const primaryModel = String(raw.primaryModel || raw.primary_model || '').trim();
  const fallbackProvider = String(raw.fallbackProvider || raw.fallback_provider || '').trim().toLowerCase();
  const fallbackModel = String(raw.fallbackModel || raw.fallback_model || '').trim();
  if (!primaryProvider || !primaryModel) return null;
  return {
    primary_provider: primaryProvider,
    primary_model: primaryModel,
    fallback_provider: fallbackProvider && fallbackModel ? fallbackProvider : null,
    fallback_model: fallbackProvider && fallbackModel ? fallbackModel : null,
  };
}

function applyRuntimeLockMetadata(existingMetadata, runtimeLock) {
  const metadata = existingMetadata && typeof existingMetadata === 'object' ? { ...existingMetadata } : {};
  if (!runtimeLock) {
    delete metadata.runtime_lock;
    delete metadata.runtimeLock;
    return Object.keys(metadata).length > 0 ? metadata : null;
  }
  metadata.runtime_lock = runtimeLock;
  delete metadata.runtimeLock;
  return metadata;
}

const DEFAULT_EXTERNAL_LEASE_SECONDS = Math.max(30, Math.min(3600, Number.parseInt(process.env.EXTERNAL_AGENT_LEASE_SECONDS || '300', 10) || 300));

function getExternalAgentConfig(agent) {
  const metadata = safeJsonParse(agent?.metadata, {});
  const external = metadata?.external_agent || metadata?.externalAgent || null;
  if (!external || typeof external !== 'object') return null;
  return external;
}

function getAgentLeaseSeconds(agent, requestedLeaseSeconds = null) {
  const external = getExternalAgentConfig(agent);
  const configured = Number.parseInt(
    String(
      requestedLeaseSeconds
      ?? external?.heartbeat_timeout_seconds
      ?? external?.heartbeatTimeoutSeconds
      ?? external?.lease_timeout_seconds
      ?? external?.leaseTimeoutSeconds
      ?? DEFAULT_EXTERNAL_LEASE_SECONDS
    ),
    10
  );
  if (!Number.isInteger(configured)) return DEFAULT_EXTERNAL_LEASE_SECONDS;
  return Math.max(30, Math.min(3600, configured));
}

function buildTaskClaimantId(agentActor) {
  const agentId = agentActor?.id ? `agent:${agentActor.id}` : 'agent:unknown';
  const keyId = agentActor?.keyId ? `key:${agentActor.keyId}` : 'key:session';
  return `${agentId}:${keyId}`;
}

function taskClaimMatchesActor(task, agentActor, runtimeAgentId = null) {
  const storedClaimant = String(task?.agent_claimed_by || '').trim();
  if (!storedClaimant) return false;

  const claimantId = buildTaskClaimantId(agentActor);
  if (storedClaimant === claimantId) return true;

  const effectiveAgentId = Number(runtimeAgentId || agentActor?.id || 0);
  if (!agentActor?.isUserKey || !Number.isInteger(effectiveAgentId) || effectiveAgentId <= 0) {
    return false;
  }

  const canonicalAgentPrefix = `agent:${effectiveAgentId}`;
  return storedClaimant === canonicalAgentPrefix || storedClaimant.startsWith(`${canonicalAgentPrefix}:`);
}

async function resolveExternalRuntimeActor(agentActor, preferredAgentId = null) {
  if (!agentActor?.isUserKey) {
    const runtimeAgent = await db.one(`
      SELECT id, name, execution_mode, metadata, owner_user_id
      FROM agents
      WHERE id = ?
    `, [agentActor?.id]);
    if (!runtimeAgent) return null;
    return {
      runtimeAgent,
      authActor: agentActor
    };
  }

  const ownedAgents = await db.many(`
    SELECT id, name, execution_mode, metadata, owner_user_id
    FROM agents
    WHERE owner_user_id = ?
      AND status = 'active'
    ORDER BY
      CASE WHEN execution_mode = 'polling' THEN 0 ELSE 1 END,
      id ASC
  `, [agentActor.userId]);

  const candidates = ownedAgents.filter((agent) => (
    String(agent.execution_mode || '').toLowerCase() === 'polling' || Boolean(getExternalAgentConfig(agent))
  ));

  const runtimeAgent = preferredAgentId
    ? candidates.find((agent) => Number(agent.id) === Number(preferredAgentId))
    : (candidates[0] || null);

  if (!runtimeAgent) return null;

  return {
    runtimeAgent,
    authActor: {
      ...agentActor,
      id: runtimeAgent.id,
      name: runtimeAgent.name,
      ownerUserId: runtimeAgent.owner_user_id || agentActor.userId
    }
  };
}

async function updateExternalAgentMetadata(agentId, applyUpdate) {
  if (!agentId) return null;
  const agent = await db.one('SELECT id, metadata FROM agents WHERE id = ?', [agentId]);
  if (!agent) return null;
  const metadata = safeJsonParse(agent.metadata, {}) || {};
  const nextExternal = {
    ...(metadata.external_agent || metadata.externalAgent || {}),
  };
  applyUpdate(nextExternal, metadata);
  metadata.external_agent = nextExternal;
  delete metadata.externalAgent;
  await db.exec(
    `UPDATE agents SET metadata = ?, updated_at = datetime('now') WHERE id = ?`,
    [JSON.stringify(metadata), agentId]
  );
  return metadata.external_agent;
}

/**
 * Check if an agent can handle a task based on capabilities and routing
 */
function canAgentHandleTask(agent, task, project) {
  const agentCaps = safeJsonParse(agent.capabilities, []);
  const agentTaskTypes = safeJsonParse(agent.task_types, ['*']);
  const agentProjectAccess = safeJsonParse(agent.project_access, ['*']);
  const taskRequiredCaps = safeJsonParse(task.required_capabilities, []);

  // Check project access
  if (!agentProjectAccess.includes('*')) {
    const projectName = project?.name?.toLowerCase();
    const projectId = String(project?.id);
    const hasProjectAccess = agentProjectAccess.some(p =>
      p === '*' || p.toLowerCase() === projectName || p === projectId
    );
    if (!hasProjectAccess) {
      return { canHandle: false, reason: 'no_project_access' };
    }
  }

  // Check task type
  if (task.task_type && !agentTaskTypes.includes('*')) {
    if (!agentTaskTypes.includes(task.task_type)) {
      return { canHandle: false, reason: 'task_type_mismatch' };
    }
  }

  // Check required capabilities
  if (taskRequiredCaps.length > 0) {
    const agentCapsLower = agentCaps.map(c => c.toLowerCase());
    const missingCaps = taskRequiredCaps.filter(c =>
      !agentCapsLower.includes(c.toLowerCase())
    );
    if (missingCaps.length > 0) {
      return { canHandle: false, reason: 'missing_capabilities', missingCaps };
    }
  }

  return { canHandle: true };
}

// ============================================
// Provider Configuration
// ============================================

const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    models: [
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', description: 'Most capable model' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Balanced performance' },
      { id: 'claude-haiku-4-20250514', name: 'Claude Haiku 4', description: 'Fast and efficient' }
    ]
  },
  openai: {
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Latest multimodal model' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: 'Fast and capable' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', description: 'Fast and affordable' }
    ]
  },
  google: {
    name: 'Google (Gemini)',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Most capable Gemini model' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast and efficient Gemini model' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'Long-context Gemini model' }
    ]
  },
  openai_compatible: {
    name: 'OpenAI-Compatible (Local/Self-Hosted)',
    models: [
      { id: 'qwen2.5:latest', name: 'Qwen 2.5', description: 'Fast local model' },
      { id: 'llama3.2:latest', name: 'Llama 3.2', description: 'Meta open-source model' },
      { id: 'deepseek-r1:latest', name: 'DeepSeek R1', description: 'Reasoning model' },
      { id: 'mistral:latest', name: 'Mistral', description: 'Efficient local model' }
    ]
  }
};

// ============================================
// Agent self-service endpoints (require agent auth)
// These must come BEFORE /:id routes to avoid "me" being matched as an ID
// ============================================

/**
 * GET /api/agents/me
 * Get current agent's details (agent auth)
 * For user keys, returns user info as a virtual agent
 */
router.get('/me', agentAuth, async (req, res) => {
  try {
    // Handle user keys (virtual agent representing the user)
    if (req.agent.isUserKey) {
      return response.success(res, {
        id: null,
        name: req.agent.userName || req.agent.userEmail,
        type: 'user',
        description: 'User key authentication',
        capabilities: req.agent.capabilities || ['*'],
        status: 'active',
        max_concurrent_tasks: req.agent.maxConcurrentTasks || 999,
        created_at: null,
        isUserKey: true,
        userId: req.agent.userId,
        userEmail: req.agent.userEmail,
        userRole: req.agent.userRole
      });
    }

    // Handle agent keys
    const agent = await db.one(`
      SELECT id, name, type, description, capabilities, status, max_concurrent_tasks, created_at
      FROM agents WHERE id = ?
    `, [req.agent.id]);

    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    response.success(res, normalizeAgentTimestamps({
      ...agent,
      capabilities: safeJsonParse(agent.capabilities, [])
    }));
  } catch (err) {
    console.error('Error getting agent self:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/agents/me/tasks
 * Get tasks assigned to current agent
 * For user keys, returns tasks assigned to agents owned by this user
 * Supports optional userName query param to filter by assignee name
 */
router.get('/me/tasks', agentAuth, async (req, res) => {
  try {
    const { status, userName } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query;
    let params;

    if (req.agent.isUserKey) {
      // User key: return tasks assigned to agents owned by this user
      const ownedIds = req.agent.ownedAgentIds || [];
      if (ownedIds.length === 0) {
        return response.success(res, []);
      }
      const placeholders = ownedIds.map(() => '?').join(',');
      query = `
        SELECT
          t.*,
          p.name as project_name,
          a.name as agent_name
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN agents a ON a.id = t.assigned_agent_id
        WHERE t.assigned_agent_id IN (${placeholders})
      `;
      params = [...ownedIds];
    } else {
      // Agent key: return tasks assigned to this specific agent
      query = `
        SELECT
          t.*,
          p.name as project_name
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.assigned_agent_id = ?
      `;
      params = [req.agent.id];
    }

    if (status) {
      query += ' AND t.status = ?';
      params.push(status);
    }

    query += ' ORDER BY t.priority ASC, t.created_at ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const tasks = await db.many(query, params);

    // Parse JSON fields and normalize timestamps
    const parsed = tasks.map(task => normalizeTaskTimestamps(task));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error getting agent tasks:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/agents/me/tasks/next
 * Get the next task from the queue (highest priority, oldest first)
 * For user keys, returns next task from agents owned by this user
 * Supports optional userName query param to filter by agent name
 */
router.get('/me/tasks/next', agentAuth, async (req, res) => {
  try {
    const { userName } = req.query;
    let inProgressCount;
    let task;

    if (req.agent.isUserKey) {
      // User key: scoped to tasks assigned to agents owned by this user
      const ownedIds = req.agent.ownedAgentIds || [];
      if (ownedIds.length === 0) {
        return response.success(res, { task: null, reason: 'no_linked_agents', message: 'No agents linked to this user. Link an agent via PUT /api/agents/:id/owner.' });
      }
      const placeholders = ownedIds.map(() => '?').join(',');

      const inProgressRow = await db.one(`
        SELECT COUNT(*) as count FROM tasks
        WHERE assigned_agent_id IN (${placeholders}) AND status = 'in_progress'
      `, ownedIds);
      inProgressCount = inProgressRow.count;

      if (inProgressCount >= req.agent.maxConcurrentTasks) {
        return response.success(res, {
          task: null,
          reason: 'concurrent_limit_reached',
          message: `At max concurrent tasks (${req.agent.maxConcurrentTasks})`
        });
      }

      task = await db.one(`
        SELECT
          t.*,
          p.name as project_name,
          a.name as agent_name
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN agents a ON a.id = t.assigned_agent_id
        WHERE t.assigned_agent_id IN (${placeholders})
          AND t.status IN ('pending', 'assigned')
        ORDER BY t.priority ASC, t.created_at ASC
        LIMIT 1
      `, ownedIds);
    } else {
      // Agent key: standard agent behavior with capability-based routing
      const agent = await db.one(`
        SELECT id, capabilities, project_access, task_types, max_concurrent_tasks, active_task_count
        FROM agents WHERE id = ?
      `, [req.agent.id]);

      const inProgressRow2 = await db.one(`
        SELECT COUNT(*) as count FROM tasks
        WHERE assigned_agent_id = ? AND status = 'in_progress'
      `, [req.agent.id]);
      inProgressCount = inProgressRow2.count;

      if (inProgressCount >= (agent?.max_concurrent_tasks || 1)) {
        return response.success(res, {
          task: null,
          reason: 'concurrent_limit_reached',
          message: `Agent is at max concurrent tasks (${agent?.max_concurrent_tasks || 1})`
        });
      }

      // First, check for tasks already assigned to this agent
      task = await db.one(`
        SELECT
          t.*,
          p.name as project_name,
          p.id as _project_id
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.assigned_agent_id = ?
          AND t.status IN ('pending', 'assigned')
        ORDER BY t.priority ASC, t.created_at ASC
        LIMIT 1
      `, [req.agent.id]);

      // If no assigned task, look for unassigned tasks matching agent's capabilities
      if (!task) {
        // Get all unassigned pending tasks
        const unassignedTasks = await db.many(`
          SELECT
            t.*,
            p.name as project_name,
            p.id as _project_id
          FROM tasks t
          LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.assigned_agent_id IS NULL
            AND t.status = 'pending'
          ORDER BY
            CASE WHEN t.preferred_agent_id = ? THEN 0 ELSE 1 END,
            t.priority ASC,
            t.created_at ASC
          LIMIT 50
        `, [req.agent.id]);

        // Filter tasks based on agent capabilities
        for (const candidateTask of unassignedTasks) {
          const project = candidateTask._project_id ? { id: candidateTask._project_id, name: candidateTask.project_name } : null;
          const result = canAgentHandleTask(agent, candidateTask, project);
          if (result.canHandle) {
            task = candidateTask;
            break;
          }
        }
      }
    }

    if (!task) {
      return response.success(res, {
        task: null,
        reason: 'no_tasks',
        message: 'No pending tasks available'
      });
    }

    response.success(res, {
      task: normalizeTaskTimestamps(task)
    });
  } catch (err) {
    console.error('Error getting next task:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents/me/tasks/poll
 * Return the next assigned task available for an external/polling worker.
 * This is task-centric and does not claim the lease by itself.
 */
router.post('/me/tasks/poll', agentAuth, async (req, res) => {
  try {
    const runtime = await resolveExternalRuntimeActor(req.agent, req.body?.agentId || req.query?.agentId || null);
    const agent = runtime?.runtimeAgent;

    if (!agent) {
      return response.notFound(res, 'External agent');
    }

    if (String(agent.execution_mode || '').toLowerCase() !== 'polling' && !getExternalAgentConfig(agent)) {
      return response.forbidden(res, 'This worker is not configured for external polling');
    }

    const claimantId = buildTaskClaimantId(runtime.authActor);
    const nowIso = new Date().toISOString();
    const task = await db.one(`
      SELECT
        t.*,
        p.name as project_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assigned_agent_id = ?
        AND t.status IN ('pending', 'assigned', 'in_progress', 'blocked')
        AND (
          t.agent_claimed_by IS NULL
          OR t.agent_claimed_by = ?
          OR t.agent_claim_expires_at IS NULL
          OR t.agent_claim_expires_at < datetime('now')
        )
      ORDER BY
        CASE
          WHEN t.status = 'assigned' THEN 0
          WHEN t.status = 'pending' THEN 1
          WHEN t.status = 'in_progress' THEN 2
          ELSE 3
        END,
        t.priority ASC,
        t.created_at ASC
      LIMIT 1
    `, [agent.id, claimantId]);

    await updateExternalAgentMetadata(agent.id, (external) => {
      external.status = 'connected';
      external.lastSeenAt = nowIso;
      external.lastPollAt = nowIso;
      external.lastConnectionType = external?.connection_type || external?.connectionType || 'api';
    });

    const external = getExternalAgentConfig(agent);
    if (!task) {
      return response.success(res, {
        task: null,
        dispatch: {
          runtime: external?.runtime_label || external?.runtimeLabel || 'Bring Your Own Agent',
          connectionType: external?.connection_type || external?.connectionType || 'api',
          allowedActions: external?.allowed_actions || external?.allowedActions || ['claim', 'heartbeat', 'progress', 'submit_result', 'request_review'],
          policy: external?.policy || 'assigned_only'
        },
        reason: 'no_tasks'
      });
    }

    return response.success(res, {
      task: normalizeTaskTimestamps(task),
      dispatch: {
        runtime: external?.runtime_label || external?.runtimeLabel || 'Bring Your Own Agent',
        connectionType: external?.connection_type || external?.connectionType || 'api',
        allowedActions: external?.allowed_actions || external?.allowedActions || ['claim', 'heartbeat', 'progress', 'submit_result', 'request_review'],
        policy: external?.policy || 'assigned_only',
        contextUrl: `/api/tasks/${task.id}/context`,
      }
    });
  } catch (err) {
    console.error('Error polling external agent tasks:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents/me/tasks/:taskId/claim
 * Claim an execution lease for an assigned task.
 */
router.post('/me/tasks/:taskId/claim', agentAuth, validateBody(claimTaskLeaseSchema), async (req, res) => {
  try {
    const taskId = Number.parseInt(req.params.taskId, 10);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return response.validationError(res, 'Invalid task ID');
    }

    const runtime = await resolveExternalRuntimeActor(req.agent, req.body?.agentId || req.query?.agentId || null);
    const agent = runtime?.runtimeAgent;
    if (!agent) {
      return response.notFound(res, 'External agent');
    }

    const task = await db.one('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) return response.notFound(res, 'Task');
    if (task.assigned_agent_id !== agent.id) {
      return response.forbidden(res, 'Task not assigned to this agent');
    }

    if (String(agent?.execution_mode || '').toLowerCase() !== 'polling' && !getExternalAgentConfig(agent)) {
      return response.forbidden(res, 'This worker is not configured for external polling');
    }
    const claimantId = buildTaskClaimantId(runtime.authActor);
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseSeconds = getAgentLeaseSeconds(agent, req.body?.leaseSeconds);
    const expiresAt = new Date(now.getTime() + (leaseSeconds * 1000)).toISOString();
    const currentClaimant = String(task.agent_claimed_by || '').trim();
    const currentExpiry = task.agent_claim_expires_at ? new Date(task.agent_claim_expires_at) : null;
    const claimIsActive = currentClaimant && currentExpiry && !Number.isNaN(currentExpiry.getTime()) && currentExpiry.getTime() > Date.now();

    if (claimIsActive && !taskClaimMatchesActor(task, runtime.authActor, agent.id)) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'TASK_ALREADY_CLAIMED',
          message: 'Task is already claimed by another worker.'
        }
      });
    }

    const nextContext = safeJsonParse(task.context, {}) || {};
    nextContext.externalExecution = {
      ...(nextContext.externalExecution || {}),
      leaseClaimedAt: now.toISOString(),
      leaseExpiresAt: expiresAt,
      claimantId,
    };
    if (req.body?.externalRunId) {
      nextContext.externalExecution.externalRunId = req.body.externalRunId;
    }

    const allowedClaimants = [claimantId];
    const claimantPrefixPatterns = [];
    if (runtime.authActor?.isUserKey) {
      allowedClaimants.push(`agent:${agent.id}`);
      claimantPrefixPatterns.push(`agent:${agent.id}:%`);
    }
    const claimantPlaceholders = allowedClaimants.map(() => '?').join(', ');
    const claimantPrefixSql = claimantPrefixPatterns.map(() => 'OR agent_claimed_by LIKE ?').join('\n          ');
    const claimResult = await db.exec(`
      UPDATE tasks
      SET agent_claimed_by = ?,
          agent_claimed_at = ?,
          agent_claim_expires_at = ?,
          agent_last_heartbeat_at = ?,
          external_execution_status = 'accepted',
          external_run_id = COALESCE(?, external_run_id),
          context = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND assigned_agent_id = ?
        AND (
          agent_claimed_by IS NULL
          OR TRIM(agent_claimed_by) = ''
          OR agent_claim_expires_at IS NULL
          OR agent_claim_expires_at <= ?
          OR agent_claimed_by IN (${claimantPlaceholders})
          ${claimantPrefixSql}
        )
    `, [
      claimantId,
      nowIso,
      expiresAt,
      nowIso,
      req.body?.externalRunId || null,
      JSON.stringify(nextContext),
      taskId,
      agent.id,
      nowIso,
      ...allowedClaimants,
      ...claimantPrefixPatterns
    ]);

    if (claimResult.changes === 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'TASK_ALREADY_CLAIMED',
          message: 'Task is already claimed by another worker.'
        }
      });
    }

    await updateExternalAgentMetadata(agent.id, (external) => {
      external.status = 'connected';
      external.lastSeenAt = now.toISOString();
      external.lastClaimAt = now.toISOString();
      external.lastHeartbeatAt = now.toISOString();
      external.lastErrorAt = null;
      external.lastErrorMessage = null;
    });

    const claimed = await db.one('SELECT * FROM tasks WHERE id = ?', [taskId]);
    return response.success(res, {
      task: normalizeTaskTimestamps(claimed),
      lease: {
        claimantId,
        claimedAt: now.toISOString(),
        expiresAt,
        leaseSeconds
      }
    });
  } catch (err) {
    console.error('Error claiming external task lease:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents/me/tasks/:taskId/heartbeat
 * Extend the lease for a claimed task and update worker heartbeat metadata.
 */
router.post('/me/tasks/:taskId/heartbeat', agentAuth, validateBody(taskLeaseHeartbeatSchema), async (req, res) => {
  try {
    const taskId = Number.parseInt(req.params.taskId, 10);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return response.validationError(res, 'Invalid task ID');
    }

    const runtime = await resolveExternalRuntimeActor(req.agent, req.body?.agentId || req.query?.agentId || null);
    const agent = runtime?.runtimeAgent;
    if (!agent) {
      return response.notFound(res, 'External agent');
    }

    const task = await db.one('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) return response.notFound(res, 'Task');
    if (task.assigned_agent_id !== agent.id) {
      return response.forbidden(res, 'Task not assigned to this agent');
    }

    const claimantId = buildTaskClaimantId(runtime.authActor);
    if (!taskClaimMatchesActor(task, runtime.authActor, agent.id)) {
      return response.forbidden(res, 'Task lease is not claimed by this worker');
    }

    if (String(agent?.execution_mode || '').toLowerCase() !== 'polling' && !getExternalAgentConfig(agent)) {
      return response.forbidden(res, 'This worker is not configured for external polling');
    }
    const now = new Date();
    const leaseSeconds = getAgentLeaseSeconds(agent, req.body?.leaseSeconds);
    const expiresAt = new Date(now.getTime() + (leaseSeconds * 1000)).toISOString();
    const nextContext = safeJsonParse(task.context, {}) || {};
    nextContext.externalExecution = {
      ...(nextContext.externalExecution || {}),
      claimantId,
      leaseClaimedAt: nextContext.externalExecution?.leaseClaimedAt || task.agent_claimed_at || now.toISOString(),
      leaseExpiresAt: expiresAt,
      lastHeartbeatAt: now.toISOString(),
    };
    if (req.body?.statusMessage) {
      nextContext.externalExecution.lastHeartbeatMessage = req.body.statusMessage;
    }
    if (req.body?.externalRunId) {
      nextContext.externalExecution.externalRunId = req.body.externalRunId;
    }

    await db.exec(`
      UPDATE tasks
      SET agent_claim_expires_at = ?,
          agent_last_heartbeat_at = ?,
          external_run_id = COALESCE(?, external_run_id),
          context = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `, [
      expiresAt,
      now.toISOString(),
      req.body?.externalRunId || null,
      JSON.stringify(nextContext),
      taskId
    ]);

    await updateExternalAgentMetadata(agent.id, (external) => {
      external.status = 'connected';
      external.lastSeenAt = now.toISOString();
      external.lastHeartbeatAt = now.toISOString();
      if (req.body?.externalRunId) external.lastRunId = req.body.externalRunId;
    });

    return response.success(res, {
      taskId,
      heartbeatAt: now.toISOString(),
      expiresAt,
      leaseSeconds
    });
  } catch (err) {
    console.error('Error heartbeating external task lease:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents/me/tasks/:taskId/release
 * Release a claimed task lease without finishing the task.
 */
router.post('/me/tasks/:taskId/release', agentAuth, validateBody(releaseTaskLeaseSchema), async (req, res) => {
  try {
    const taskId = Number.parseInt(req.params.taskId, 10);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return response.validationError(res, 'Invalid task ID');
    }

    const runtime = await resolveExternalRuntimeActor(req.agent, req.body?.agentId || req.query?.agentId || null);
    const agent = runtime?.runtimeAgent;
    if (!agent) {
      return response.notFound(res, 'External agent');
    }

    const task = await db.one('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) return response.notFound(res, 'Task');
    if (task.assigned_agent_id !== agent.id) {
      return response.forbidden(res, 'Task not assigned to this agent');
    }

    const claimantId = buildTaskClaimantId(runtime.authActor);
    if (!taskClaimMatchesActor(task, runtime.authActor, agent.id)) {
      return response.forbidden(res, 'Task lease is not claimed by this worker');
    }

    const nextContext = safeJsonParse(task.context, {}) || {};
    nextContext.externalExecution = {
      ...(nextContext.externalExecution || {}),
      lastReleasedAt: new Date().toISOString(),
      lastReleaseReason: req.body?.reason || null,
      abandoned: Boolean(req.body?.abandon)
    };

    await db.exec(`
      UPDATE tasks
      SET agent_claimed_by = NULL,
          agent_claimed_at = NULL,
          agent_claim_expires_at = NULL,
          external_execution_status = CASE
            WHEN external_execution_status IN ('submitted', 'failed', 'canceled') THEN external_execution_status
            ELSE 'queued'
          END,
          context = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `, [JSON.stringify(nextContext), taskId]);

    await updateExternalAgentMetadata(agent.id, (external) => {
      external.status = 'connected';
      external.lastReleaseAt = new Date().toISOString();
    });

    return response.success(res, {
      released: true,
      taskId
    });
  } catch (err) {
    console.error('Error releasing external task lease:', err);
    response.serverError(res);
  }
});

// ============================================
// Provider Configuration Endpoint
// This must come BEFORE /:id routes to avoid "providers" matching as an ID
// ============================================

/**
 * GET /api/agents/providers
 * List supported providers and their models
 */
router.get('/providers', dualAuth, (_req, res) => {
  response.success(res, PROVIDERS);
});

// ============================================
// Admin endpoints (require user authentication)
// ============================================

/**
 * POST /api/agents/match
 * Advisory matching endpoint - returns list of matching agents with scores
 * Does not assign tasks, just provides recommendations
 */
router.post('/match', dualAuth, validateBody(matchAgentsSchema), async (req, res) => {
  try {
    const { tags = [], priority, metadata = {} } = req.body;

    // Get all active agents with their details
    const agents = await db.many(`
      SELECT
        id, name, type, description, capabilities, specializations, metadata, status,
        max_concurrent_tasks, active_task_count
      FROM agents
      WHERE status = 'active'
    `, []);

    // Calculate match scores for each agent
    const matches = agents.map(agent => {
      const capabilities = safeJsonParse(agent.capabilities, []);
      const specializations = safeJsonParse(agent.specializations, {});
      const agentMetadata = safeJsonParse(agent.metadata, {});

      let score = 0;
      const matchReasons = [];

      // Score capability matches (0.4 weight per match, max 0.8)
      const capabilityMatches = tags.filter(tag =>
        capabilities.some(cap => cap.toLowerCase() === tag.toLowerCase())
      );
      if (capabilityMatches.length > 0) {
        score += Math.min(0.8, capabilityMatches.length * 0.4);
        matchReasons.push(`capabilities: ${capabilityMatches.join(', ')}`);
      }

      // Score specialization matches (business_lines, content_types, etc.)
      const businessLines = specializations.business_lines || [];
      const businessLineMatches = tags.filter(tag =>
        businessLines.some(bl => bl.toLowerCase() === tag.toLowerCase())
      );
      if (businessLineMatches.length > 0) {
        score += Math.min(0.3, businessLineMatches.length * 0.15);
        matchReasons.push(`business_lines: ${businessLineMatches.join(', ')}`);
      }

      const contentTypes = specializations.content_types || [];
      const contentTypeMatches = tags.filter(tag =>
        contentTypes.some(ct => ct.toLowerCase() === tag.toLowerCase())
      );
      if (contentTypeMatches.length > 0) {
        score += Math.min(0.2, contentTypeMatches.length * 0.1);
        matchReasons.push(`content_types: ${contentTypeMatches.join(', ')}`);
      }

      // Check availability (treat NULL active_task_count as 0)
      const activeCount = agent.active_task_count ?? 0;
      const available = agent.max_concurrent_tasks === null ||
        activeCount < agent.max_concurrent_tasks;

      // Slight boost for available agents
      if (available) {
        score += 0.05;
      }

      return {
        agent_id: agent.id,
        agent_name: agent.name,
        match_reason: matchReasons.length > 0 ? matchReasons.join('; ') : 'no specific match',
        match_score: Math.round(score * 100) / 100,
        available,
        active_tasks: agent.active_task_count || 0,
        max_tasks: agent.max_concurrent_tasks
      };
    });

    // Sort by score descending, then by availability
    matches.sort((a, b) => {
      if (b.match_score !== a.match_score) {
        return b.match_score - a.match_score;
      }
      // Prefer available agents
      return (b.available ? 1 : 0) - (a.available ? 1 : 0);
    });

    // Filter out zero-score matches unless no matches found
    const relevantMatches = matches.filter(m => m.match_score > 0);

    response.success(res, {
      matches: relevantMatches.length > 0 ? relevantMatches : matches.slice(0, 5)
    });
  } catch (err) {
    console.error('Error matching agents:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/agents
 * List all agents (admin only)
 * Query params:
 *   - capability: Filter by capability (e.g., 'content-writing')
 *   - status: Filter by status ('active', 'paused', 'disabled')
 *   - available: Only agents with capacity ('true')
 *   - business_line: Search in specializations.business_lines
 */
router.get('/', dualAuth, async (req, res) => {
  try {
    if (req.agent && !req.agent.isUserKey) {
      return response.forbidden(res, 'User session or user API key required');
    }

    const { capability, status, available, business_line } = req.query;

    // Build query with filters
    let query = `
      SELECT
        agents.id, agents.name, agents.type, agents.description, agents.capabilities, agents.specializations, agents.metadata, agents.status,
        agents.webhook_url, agents.webhook_events, agents.max_concurrent_tasks, agents.active_task_count,
        agents.execution_mode, agents.owner_user_id, agents.project_access,
        u.is_agent_user AS owner_user_is_agent_user,
        u.name AS owner_user_name,
        u.email AS owner_user_email,
        agents.provider, agents.provider_model, agents.provider_base_url, agents.provider_label,
        agents.provider_api_key_encrypted,
        agents.created_at, agents.updated_at,
        (SELECT COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) FROM deliverables WHERE agent_id = agents.id) as total_tokens
      FROM agents
      LEFT JOIN users u ON u.id = agents.owner_user_id
      WHERE 1=1
    `;
    const params = [];

    // Filter by status
    if (status) {
      query += ' AND agents.status = ?';
      params.push(status);
    }

    // Filter by availability (active_task_count < max_concurrent_tasks or max_concurrent_tasks is null)
    if (available === 'true') {
      query += ' AND (max_concurrent_tasks IS NULL OR active_task_count < max_concurrent_tasks)';
    }

    query += ' ORDER BY agents.created_at DESC';

    let agents = await db.many(query, params);

    // Parse JSON fields and normalize timestamps
    agents = agents.map(agent => normalizeAgentTimestamps(agent));

    // Filter by capability (in-memory since it's a JSON array)
    if (capability) {
      agents = agents.filter(agent =>
        agent.capabilities.some(cap =>
          cap.toLowerCase() === capability.toLowerCase()
        )
      );
    }

    // Filter by business_line (search in specializations.business_lines)
    if (business_line) {
      agents = agents.filter(agent => {
        const businessLines = agent.specializations?.business_lines || [];
        return businessLines.some(bl =>
          bl.toLowerCase() === business_line.toLowerCase()
        );
      });
    }

    response.success(res, agents);
  } catch (err) {
    console.error('Error listing agents:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents
 * Register a new agent
 */
router.post('/', dualAuth, requireUserOrUserKeyRoles('admin'), validateBody(createAgentSchema), async (req, res) => {
  try {
    const {
      name, type, description, capabilities, specializations, metadata, maxConcurrentTasks,
      agentType, specialization, projectAccess, taskTypes,
      // Optional execution fields (one-step create)
      provider, providerApiKey, providerModel, providerBaseUrl, providerLabel,
      runtimeLock,
      systemPrompt, executionMode, maxTokens, temperature
    } = req.body;
    const normalizedRuntimeLock = normalizeRuntimeLockPayload(runtimeLock);
    const runtimeLockError = await assertRuntimeLockAllowed(null, normalizedRuntimeLock);
    if (runtimeLockError) {
      return response.forbidden(res, runtimeLockError);
    }
    const mergedMetadata = applyRuntimeLockMetadata(metadata, normalizedRuntimeLock);

    // Reject providerBaseUrl for openai provider (use openai_compatible instead)
    if (provider === 'openai' && providerBaseUrl) {
      return response.badRequest(res, 'Base URL is not supported for OpenAI provider. Use openai_compatible instead.');
    }

    // Validate providerBaseUrl if provided
    let validatedBaseUrl = null;
    if (providerBaseUrl && providerBaseUrl.trim()) {
      const urlCheck = await validateProviderBaseUrl(providerBaseUrl);
      if (!urlCheck.valid) {
        return response.badRequest(res, `Invalid base URL: ${urlCheck.reason}`);
      }
      validatedBaseUrl = urlCheck.normalizedUrl;
    }

    // Encrypt provider API key if provided
    let encryptedKey = null, encryptedIv = null, keyVersion = null;
    if (providerApiKey) {
      const encResult = encrypt(providerApiKey);
      encryptedKey = encResult.encrypted;
      encryptedIv = encResult.iv;
      keyVersion = encResult.keyVersion;
    }

    const result = await db.insert(`
      INSERT INTO agents (
        name, type, description, capabilities, specializations, metadata, max_concurrent_tasks,
        agent_type, specialization, project_access, task_types,
        provider, provider_api_key_encrypted, provider_api_key_iv, encryption_key_version,
        provider_model, provider_base_url, provider_label,
        system_prompt, execution_mode, max_tokens, temperature
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      type,
      description || null,
      JSON.stringify(capabilities),
      specializations ? JSON.stringify(specializations) : null,
      mergedMetadata ? JSON.stringify(mergedMetadata) : null,
      maxConcurrentTasks ?? 5,
      agentType || 'general',
      specialization || null,
      JSON.stringify(projectAccess || ['*']),
      JSON.stringify(taskTypes || ['*']),
      provider || null,
      encryptedKey,
      encryptedIv,
      keyVersion,
      providerModel || null,
      validatedBaseUrl,
      providerLabel || null,
      systemPrompt || null,
      executionMode || (provider ? 'manual' : 'manual'),
      maxTokens || 4096,
      temperature ?? 0.7
    ]);

    const agent = await db.one('SELECT * FROM agents WHERE id = ?', [result.lastInsertRowid]);

    // Note: agent.registered is a global event (not project-scoped)
    // Dispatch to all projects that have routes listening for this event
    const projectsWithAgentRoutes = await db.many(`
      SELECT DISTINCT project_id FROM routes WHERE trigger_event = 'agent.registered' AND enabled = 1
    `, []);

    for (const { project_id } of projectsWithAgentRoutes) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [project_id]);
      dispatchEvent('agent.registered', {
        project: project ? { id: project.id, name: project.name } : { id: project_id },
        projectId: project_id,
        agent: {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          description: agent.description,
          capabilities: safeJsonParse(agent.capabilities, []),
          specializations: safeJsonParse(agent.specializations, {}),
          status: agent.status
        },
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Agents] Route dispatch error:', err));
    }

    response.created(res, normalizeAgentTimestamps(agent));
  } catch (err) {
    console.error('Error creating agent:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/agents/:id
 * Get agent details
 */
router.get('/:id', dualAuth, async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one(`
      SELECT
        agents.*,
        u.is_agent_user AS owner_user_is_agent_user,
        u.name AS owner_user_name,
        u.email AS owner_user_email
      FROM agents
      LEFT JOIN users u ON u.id = agents.owner_user_id
      WHERE agents.id = ?
    `, [req.params.id]);

    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    // Get API keys (without hash)
    const keys = await db.many(`
      SELECT id, key_prefix, name, scopes, last_used_at, expires_at, revoked_at, created_at
      FROM agent_keys
      WHERE agent_id = ?
      ORDER BY created_at DESC
    `, [req.params.id]);

    const ownerUserKeys = agent.owner_user_id && Number(agent.owner_user_is_agent_user || 0) === 1
      ? await db.many(`
        SELECT id, key_prefix, name, last_used_at, created_at
        FROM user_keys
        WHERE user_id = ?
        ORDER BY created_at DESC
      `, [agent.owner_user_id])
      : [];

    response.success(res, normalizeAgentTimestamps({
      ...agent,
      owner_user_is_agent_user: Boolean(Number(agent.owner_user_is_agent_user || 0)),
      owner_user: agent.owner_user_id ? {
        id: agent.owner_user_id,
        name: agent.owner_user_name || null,
        email: agent.owner_user_email || null,
        is_agent_user: Boolean(Number(agent.owner_user_is_agent_user || 0))
      } : null,
      owner_user_keys: ownerUserKeys.map((key) => normalizeKeyTimestamps({
        ...key,
        prefix: key.key_prefix
      })),
      keys: keys.map(k => normalizeKeyTimestamps({
        ...k,
        prefix: k.key_prefix,
        scopes: safeJsonParse(k.scopes, [])
      }))
    }));
  } catch (err) {
    console.error('Error getting agent:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/agents/:id/metrics
 * Get agent performance metrics
 * Query params:
 *   - period: '7d', '30d', '90d', 'all' (default: '30d')
 */
router.get('/:id/metrics', dualAuth, async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one(`
      SELECT id, name FROM agents WHERE id = ?
    `, [req.params.id]);

    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const period = req.query.period || '30d';
    const validPeriods = ['7d', '30d', '90d', 'all'];
    if (!validPeriods.includes(period)) {
      return response.badRequest(res, `Invalid period. Must be one of: ${validPeriods.join(', ')}`);
    }

    // Calculate date filter based on period
    let dateFilter = '';
    let dateFilterDeliverables = '';
    if (period !== 'all') {
      const days = parseInt(period);
      dateFilter = `AND t.updated_at >= datetime('now', '-${days} days')`;
      dateFilterDeliverables = `AND d.updated_at >= datetime('now', '-${days} days')`;
    }

    // Task metrics
    const taskStats = await db.one(`
      SELECT
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as tasks_completed,
        COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as tasks_in_progress,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as tasks_failed
      FROM tasks t
      WHERE t.assigned_agent_id = ?
      ${dateFilter}
    `, [req.params.id]);

    // Average completion time (only for tasks with both started_at and completed_at)
    const avgExpr = db.dialect === 'postgres'
      ? 'AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60)'
      : db.dialect === 'mysql'
        ? 'AVG(TIMESTAMPDIFF(MINUTE, started_at, completed_at))'
        : 'AVG((julianday(completed_at) - julianday(started_at)) * 24 * 60)';
    const avgCompletionTime = await db.one(`
      SELECT ${avgExpr} as avg_minutes
      FROM tasks t
      WHERE t.assigned_agent_id = ?
        AND t.status = 'completed'
        AND t.started_at IS NOT NULL
        AND t.completed_at IS NOT NULL
        ${dateFilter}
    `, [req.params.id]);

    // Deliverable metrics
    const deliverableStats = await db.one(`
      SELECT
        COUNT(*) as deliverables_submitted,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as deliverables_approved,
        COUNT(CASE WHEN status = 'revision_requested' THEN 1 END) as deliverables_revision_requested,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as deliverables_rejected
      FROM deliverables d
      WHERE d.agent_id = ?
      ${dateFilterDeliverables}
    `, [req.params.id]);

    // Token usage stats
    const tokenStats = await db.one(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens
      FROM deliverables d
      WHERE d.agent_id = ?
      ${dateFilterDeliverables}
    `, [req.params.id]);

    // First-time approval rate (version = 1 and approved)
    const firstTimeApproval = await db.one(`
      SELECT
        COUNT(CASE WHEN status = 'approved' AND version = 1 THEN 1 END) as first_time_approved,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as total_approved
      FROM deliverables d
      WHERE d.agent_id = ?
      ${dateFilterDeliverables}
    `, [req.params.id]);

    // Recent activity (last 7 days regardless of period filter)
    const completedDateExpr = agentDateBucket('t.completed_at');
    const deliverableDateExpr = agentDateBucket('d.created_at');
    const recentActivity = await db.many(`
      SELECT
        ${completedDateExpr} as date,
        COUNT(t.id) as tasks_completed,
        0 as deliverables_submitted
      FROM tasks t
      WHERE t.assigned_agent_id = ?
        AND t.status = 'completed'
        AND t.completed_at >= datetime('now', '-7 days')
      GROUP BY ${completedDateExpr}
    `, [req.params.id]);

    const recentDeliverables = await db.many(`
      SELECT
        ${deliverableDateExpr} as date,
        COUNT(d.id) as deliverables_submitted
      FROM deliverables d
      WHERE d.agent_id = ?
        AND d.created_at >= datetime('now', '-7 days')
      GROUP BY ${deliverableDateExpr}
    `, [req.params.id]);

    // Merge recent activity data
    const activityMap = new Map();

    // Initialize last 7 days
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      activityMap.set(dateStr, { date: dateStr, tasks_completed: 0, deliverables_submitted: 0 });
    }

    // Fill in task completions
    for (const row of recentActivity) {
      const dateKey = normalizeDateBucket(row.date);
      if (activityMap.has(dateKey)) {
        activityMap.get(dateKey).tasks_completed = row.tasks_completed;
      }
    }

    // Fill in deliverable submissions
    for (const row of recentDeliverables) {
      const dateKey = normalizeDateBucket(row.date);
      if (activityMap.has(dateKey)) {
        activityMap.get(dateKey).deliverables_submitted = row.deliverables_submitted;
      }
    }

    // Sort by date descending
    const recentActivityMerged = Array.from(activityMap.values())
      .sort((a, b) => b.date.localeCompare(a.date));

    // Calculate rates
    const totalDeliverables = deliverableStats.deliverables_submitted || 0;
    const approvedDeliverables = deliverableStats.deliverables_approved || 0;
    const approvalRate = totalDeliverables > 0
      ? Math.round((approvedDeliverables / totalDeliverables) * 100) / 100
      : 0;

    const totalApproved = firstTimeApproval.total_approved || 0;
    const firstTimeApprovedCount = firstTimeApproval.first_time_approved || 0;
    const firstTimeApprovalRate = totalApproved > 0
      ? Math.round((firstTimeApprovedCount / totalApproved) * 100) / 100
      : 0;

    response.success(res, {
      agent_id: agent.id,
      agent_name: agent.name,
      period,
      metrics: {
        tasks_completed: taskStats.tasks_completed || 0,
        tasks_in_progress: taskStats.tasks_in_progress || 0,
        tasks_failed: taskStats.tasks_failed || 0,
        avg_completion_time_minutes: avgCompletionTime.avg_minutes
          ? Math.round(avgCompletionTime.avg_minutes)
          : null,
        deliverables_submitted: deliverableStats.deliverables_submitted || 0,
        deliverables_approved: deliverableStats.deliverables_approved || 0,
        deliverables_revision_requested: deliverableStats.deliverables_revision_requested || 0,
        deliverables_rejected: deliverableStats.deliverables_rejected || 0,
        approval_rate: approvalRate,
        first_time_approval_rate: firstTimeApprovalRate,
        total_input_tokens: tokenStats.total_input_tokens,
        total_output_tokens: tokenStats.total_output_tokens,
        total_tokens: tokenStats.total_input_tokens + tokenStats.total_output_tokens
      },
      recent_activity: recentActivityMerged
    });
  } catch (err) {
    console.error('Error getting agent metrics:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/agents/:id
 * Update agent
 */
router.patch('/:id', dualAuth, requireUserOrUserKeyRoles('admin'), validateBody(updateAgentSchema), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one('SELECT id, status, owner_user_id FROM agents WHERE id = ?', [req.params.id]);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const {
      name, type, description, capabilities, specializations, metadata, status,
      webhookUrl, webhookEvents, maxConcurrentTasks,
      agentType, specialization, projectAccess, taskTypes
    } = req.body;

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (type !== undefined) {
      updates.push('type = ?');
      values.push(type);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (capabilities !== undefined) {
      updates.push('capabilities = ?');
      values.push(JSON.stringify(capabilities));
    }
    if (specializations !== undefined) {
      updates.push('specializations = ?');
      values.push(specializations ? JSON.stringify(specializations) : null);
    }
    if (metadata !== undefined) {
      updates.push('metadata = ?');
      values.push(metadata ? JSON.stringify(metadata) : null);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }
    if (webhookUrl !== undefined) {
      updates.push('webhook_url = ?');
      values.push(webhookUrl);
    }
    // New agent routing fields
    if (agentType !== undefined) {
      updates.push('agent_type = ?');
      values.push(agentType);
    }
    if (specialization !== undefined) {
      updates.push('specialization = ?');
      values.push(specialization);
    }
    if (projectAccess !== undefined) {
      updates.push('project_access = ?');
      values.push(JSON.stringify(projectAccess));
    }
    if (taskTypes !== undefined) {
      updates.push('task_types = ?');
      values.push(JSON.stringify(taskTypes));
    }
    if (webhookEvents !== undefined) {
      updates.push('webhook_events = ?');
      values.push(JSON.stringify(webhookEvents));
    }
    if (maxConcurrentTasks !== undefined) {
      updates.push('max_concurrent_tasks = ?');
      values.push(maxConcurrentTasks);
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    await db.exec(`
      UPDATE agents SET ${updates.join(', ')} WHERE id = ?
    `, values);

    const updated = await db.one('SELECT * FROM agents WHERE id = ?', [req.params.id]);

    // Dispatch agent.status_changed if status was updated
    if (status !== undefined) {
      dispatchEvent('agent.status_changed', {
        agent: {
          id: updated.id,
          name: updated.name,
          type: updated.type,
          execution_mode: updated.execution_mode,
          status: updated.status,
          owner_user_id: updated.owner_user_id
        },
        old_status: agent.status || 'active',
        new_status: status,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Agents] Route dispatch error:', err));
    }

    response.success(res, normalizeAgentTimestamps(updated));
  } catch (err) {
    console.error('Error updating agent:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/agents/:id
 * Delete agent
 */
router.delete('/:id', dualAuth, requireUserOrUserKeyRoles('admin'), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one('SELECT id, name FROM agents WHERE id = ?', [req.params.id]);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    // Block deletion if agent has active (non-terminal) tasks
    const activeTaskRow = await db.one(`
      SELECT COUNT(*) as count FROM tasks
      WHERE assigned_agent_id = ? AND status NOT IN ('completed', 'cancelled', 'blocked', 'deferred')
    `, [req.params.id]);
    const activeTaskCount = activeTaskRow.count;

    if (activeTaskCount > 0) {
      return response.validationError(res,
        `Cannot delete agent "${agent.name}" — ${activeTaskCount} active task(s) are still assigned. Reassign or complete them first.`
      );
    }

    await db.exec('DELETE FROM agents WHERE id = ?', [req.params.id]);

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting agent:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents/:id/keys
 * Generate a new API key for an agent
 */
router.post('/:id/keys', dualAuth, requireUserOrUserKeyRoles('admin'), keyGenLimiter, validateBody(generateKeySchema), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one('SELECT id FROM agents WHERE id = ?', [req.params.id]);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const { name, scopes, expiresAt } = req.body;
    const { key, hash, prefix } = generateApiKey();

    const result = await db.insert(`
      INSERT INTO agent_keys (agent_id, key_hash, key_prefix, name, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      req.params.id,
      hash,
      prefix,
      name || null,
      JSON.stringify(scopes),
      expiresAt || null
    ]);

    // Return the key once - it cannot be retrieved again
    response.created(res, {
      id: result.lastInsertRowid,
      key, // Only time the full key is returned
      prefix,
      name: name || null,
      scopes,
      expiresAt: expiresAt || null,
      message: 'Store this key securely - it cannot be retrieved again'
    });
  } catch (err) {
    console.error('Error generating API key:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/agents/:id/keys/:keyId
 * Revoke an API key
 */
router.delete('/:id/keys/:keyId', dualAuth, requireUserOrUserKeyRoles('admin'), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const key = await db.one(`
      SELECT id FROM agent_keys WHERE id = ? AND agent_id = ?
    `, [req.params.keyId, req.params.id]);

    if (!key) {
      return response.notFound(res, 'API key');
    }

    await db.exec(`
      UPDATE agent_keys SET revoked_at = datetime('now') WHERE id = ?
    `, [req.params.keyId]);

    response.success(res, { revoked: true });
  } catch (err) {
    console.error('Error revoking API key:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents/:id/webhook-secret
 * Generate a new webhook secret for an agent
 */
router.post('/:id/webhook-secret', dualAuth, requireUserOrUserKeyRoles('admin'), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one('SELECT id FROM agents WHERE id = ?', [req.params.id]);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const secret = generateWebhookSecret();

    await db.exec(`
      UPDATE agents SET webhook_secret = ?, updated_at = datetime('now') WHERE id = ?
    `, [secret, req.params.id]);

    // Return secret once - should be stored by agent
    response.success(res, {
      secret,
      message: 'Store this secret securely - it will be used to sign webhook payloads'
    });
  } catch (err) {
    console.error('Error generating webhook secret:', err);
    response.serverError(res);
  }
});

// ============================================
// Execution & Owner Endpoints
// ============================================

/**
 * PUT /api/agents/:id/owner
 * Link or unlink an agent to a user
 */
router.put('/:id/owner', dualAuth, requireUserOrUserKeyRoles('admin'), validateBody(updateAgentOwnerSchema), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one('SELECT id FROM agents WHERE id = ?', [req.params.id]);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const { userId } = req.body;

    // Validate user exists if linking
    if (userId !== null && userId !== undefined) {
      const user = await db.one('SELECT id, name FROM users WHERE id = ?', [userId]);
      if (!user) {
        return response.notFound(res, 'User');
      }
    }

    await db.exec(`
      UPDATE agents SET owner_user_id = ?, updated_at = datetime('now') WHERE id = ?
    `, [userId || null, req.params.id]);

    response.success(res, { linked: userId !== null });
  } catch (err) {
    console.error('Error updating agent owner:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents/:id/test-connection
 * Test provider API key connectivity
 */
router.post('/:id/test-connection', dualAuth, requireUserOrUserKeyRoles('admin'), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one(`
      SELECT id, provider, provider_api_key_encrypted, provider_api_key_iv, encryption_key_version, provider_model, provider_base_url
      FROM agents WHERE id = ?
    `, [req.params.id]);

    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    // Get API key from request body or decrypt from database
    let apiKey = req.body.apiKey;
    const provider = req.body.provider || agent.provider;
    const model = req.body.model || agent.provider_model;

    if (!apiKey && agent.provider_api_key_encrypted) {
      apiKey = decrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv, agent.encryption_key_version);
    }

    if (!provider) {
      return response.badRequest(res, 'Provider is required');
    }

    // API key is required for anthropic/openai/google, optional for openai_compatible
    if (!apiKey && provider !== 'openai_compatible') {
      return response.badRequest(res, 'API key is required for this provider');
    }

    // Resolve base URL for openai_compatible
    let baseUrl = null;
    if (provider === 'openai_compatible' || provider === 'openai') {
      // Use request body baseUrl, or fall back to agent's saved URL
      const requestBaseUrl = req.body.baseUrl;
      if (provider === 'openai_compatible') {
        baseUrl = requestBaseUrl || agent.provider_base_url || resolveBaseUrl({ ...agent, provider });
      }

      // Validate the base URL if present
      if (baseUrl) {
        const urlCheck = await validateProviderBaseUrl(baseUrl);
        if (!urlCheck.valid) {
          return response.badRequest(res, `Invalid base URL: ${urlCheck.reason}`);
        }
        baseUrl = urlCheck.normalizedUrl;
      }
    }

    // Import and use agent executor for test
    const { testConnection } = await import('../services/agentExecutor.js');

    try {
      const result = await testConnection(provider, apiKey, model, baseUrl);
      return response.success(res, result);
    } catch (fetchError) {
      return response.success(res, {
        success: false,
        message: fetchError.message || 'Network error'
      });
    }
  } catch (err) {
    console.error('Error testing connection:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/agents/:id/execute
 * Trigger task execution for an agent
 */
router.post('/:id/execute', dualAuth, requireUserOrUserKeyRoles('admin'), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one(`
      SELECT * FROM agents WHERE id = ?
    `, [req.params.id]);

    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    if (!agent.provider) {
      return response.badRequest(res, 'Agent provider not configured');
    }
    if (!agent.provider_api_key_encrypted && agent.provider !== 'openai_compatible') {
      return response.badRequest(res, 'Agent API key not configured');
    }

    const { taskId } = req.body;
    if (!taskId) {
      return response.badRequest(res, 'taskId is required');
    }

    const task = await db.one(`
      SELECT * FROM tasks WHERE id = ? AND assigned_agent_id = ?
    `, [taskId, req.params.id]);

    if (!task) {
      return response.notFound(res, 'Task not assigned to this agent');
    }

    // Import and use agent executor
    const { executeTask } = await import('../services/agentExecutor.js');
    const result = await executeTask(agent, task);

    response.success(res, result);
  } catch (err) {
    console.error('Error executing task:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/agents/:id/execution
 * Update agent execution configuration
 */
router.patch('/:id/execution', dualAuth, requireUserOrUserKeyRoles('admin'), validateBody(updateAgentExecutionSchema), async (req, res) => {
  try {
    const scoped = await requireScopedAgent(req, res, req.params.id);
    if (scoped === null) return;
    const agent = await db.one('SELECT id, provider, metadata FROM agents WHERE id = ?', [req.params.id]);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const {
      provider,
      providerApiKey,
      providerModel,
      providerBaseUrl,
      providerLabel,
      runtimeLock,
      systemPrompt,
      executionMode,
      maxTokens,
      temperature
    } = req.body;
    const normalizedRuntimeLock = normalizeRuntimeLockPayload(runtimeLock);
    const runtimeLockError = await assertRuntimeLockAllowed(null, normalizedRuntimeLock);
    if (runtimeLockError) {
      return response.forbidden(res, runtimeLockError);
    }

    // Determine the effective provider (what it will be after this update)
    const effectiveProvider = provider !== undefined ? provider : agent.provider;

    // Reject providerBaseUrl for openai provider
    if (effectiveProvider === 'openai' && providerBaseUrl) {
      return response.badRequest(res, 'Base URL is not supported for OpenAI provider. Use openai_compatible instead.');
    }

    const updates = [];
    const values = [];

    if (provider !== undefined) {
      updates.push('provider = ?');
      values.push(provider || null);
    }

    if (providerApiKey !== undefined) {
      if (providerApiKey) {
        const { encrypted, iv, keyVersion } = encrypt(providerApiKey);
        updates.push('provider_api_key_encrypted = ?', 'provider_api_key_iv = ?', 'encryption_key_version = ?');
        values.push(encrypted, iv, keyVersion);
      } else {
        updates.push('provider_api_key_encrypted = ?', 'provider_api_key_iv = ?', 'encryption_key_version = ?');
        values.push(null, null, null);
      }
    }

    if (providerModel !== undefined) {
      updates.push('provider_model = ?');
      values.push(providerModel || null);
    }

    // Handle providerBaseUrl
    if (providerBaseUrl !== undefined) {
      if (providerBaseUrl && providerBaseUrl.trim()) {
        const urlCheck = await validateProviderBaseUrl(providerBaseUrl);
        if (!urlCheck.valid) {
          return response.badRequest(res, `Invalid base URL: ${urlCheck.reason}`);
        }
        updates.push('provider_base_url = ?');
        values.push(urlCheck.normalizedUrl);
      } else {
        // Explicitly clearing the base URL
        updates.push('provider_base_url = ?');
        values.push(null);
      }
    }

    // Handle providerLabel
    if (providerLabel !== undefined) {
      updates.push('provider_label = ?');
      values.push(providerLabel || null);
    }

    if (runtimeLock !== undefined) {
      const currentMetadata = safeJsonParse(agent.metadata, {});
      const nextMetadata = applyRuntimeLockMetadata(currentMetadata, normalizedRuntimeLock);
      updates.push('metadata = ?');
      values.push(nextMetadata && Object.keys(nextMetadata).length > 0 ? JSON.stringify(nextMetadata) : null);
    }

    if (systemPrompt !== undefined) {
      updates.push('system_prompt = ?');
      values.push(systemPrompt || null);
    }

    if (executionMode !== undefined) {
      updates.push('execution_mode = ?');
      values.push(executionMode || 'manual');
    }

    if (maxTokens !== undefined) {
      updates.push('max_tokens = ?');
      values.push(maxTokens || 4096);
    }

    if (temperature !== undefined) {
      updates.push('temperature = ?');
      values.push(temperature ?? 0.7);
    }

    if (updates.length === 0) {
      return response.badRequest(res, 'No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    await db.exec(`
      UPDATE agents SET ${updates.join(', ')} WHERE id = ?
    `, values);

    // When API key or provider is updated, clear execution errors on stuck tasks
    // so the dispatcher will retry them with the new credentials
    if (providerApiKey !== undefined || provider !== undefined) {
      const stuckTasks = await db.many(`
        SELECT id, context FROM tasks
        WHERE assigned_agent_id = ? AND status = 'assigned' AND context IS NOT NULL
      `, [req.params.id]);

      let cleared = 0;
      for (const task of stuckTasks) {
        try {
          const ctx = JSON.parse(task.context || '{}');
          if (ctx.lastExecutionError) {
            delete ctx.lastExecutionError;
            await db.exec('UPDATE tasks SET context = ?, updated_at = datetime(\'now\') WHERE id = ?',
              [JSON.stringify(ctx), task.id]);
            cleared++;
          }
        } catch { /* skip malformed context */ }
      }
      if (cleared > 0) {
        console.log(`[Agents] Cleared execution errors on ${cleared} task(s) for agent #${req.params.id} after credential update`);
      }
    }

    response.success(res, { updated: true });
  } catch (err) {
    console.error('Error updating execution config:', err);
    response.serverError(res);
  }
});

export default router;
