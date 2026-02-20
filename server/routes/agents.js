import { Router } from 'express';
import db from '../db/connection.js';
import { generateApiKey, generateWebhookSecret, encrypt, decrypt } from '../utils/crypto.js';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { agentAuth } from '../middleware/agentAuth.js';
import { keyGenLimiter } from '../middleware/security.js';
import { dispatchEvent } from '../services/routeDispatcher.js';
import {
  validateBody,
  createAgentSchema,
  updateAgentSchema,
  generateKeySchema,
  matchAgentsSchema,
  updateAgentOwnerSchema,
  updateAgentExecutionSchema
} from '../utils/validation.js';

const router = Router();

/**
 * Convert SQLite timestamp to ISO 8601 format
 * SQLite returns "YYYY-MM-DD HH:MM:SS" but JS needs "YYYY-MM-DDTHH:MM:SS.000Z"
 */
function toISOTimestamp(timestamp) {
  if (!timestamp) return null;
  if (timestamp.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp)) {
    return timestamp;
  }
  const isoString = timestamp.replace(' ', 'T');
  return isoString.includes('.') ? `${isoString}Z` : `${isoString}.000Z`;
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
    started_at: toISOTimestamp(task.started_at)
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
router.get('/me', agentAuth, (req, res) => {
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
    const agent = db.prepare(`
      SELECT id, name, type, description, capabilities, status, max_concurrent_tasks, created_at
      FROM agents WHERE id = ?
    `).get(req.agent.id);

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
router.get('/me/tasks', agentAuth, (req, res) => {
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

    const tasks = db.prepare(query).all(...params);

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
router.get('/me/tasks/next', agentAuth, (req, res) => {
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

      inProgressCount = db.prepare(`
        SELECT COUNT(*) as count FROM tasks
        WHERE assigned_agent_id IN (${placeholders}) AND status = 'in_progress'
      `).get(...ownedIds).count;

      if (inProgressCount >= req.agent.maxConcurrentTasks) {
        return response.success(res, {
          task: null,
          reason: 'concurrent_limit_reached',
          message: `At max concurrent tasks (${req.agent.maxConcurrentTasks})`
        });
      }

      task = db.prepare(`
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
      `).get(...ownedIds);
    } else {
      // Agent key: standard agent behavior with capability-based routing
      const agent = db.prepare(`
        SELECT id, capabilities, project_access, task_types, max_concurrent_tasks, active_task_count
        FROM agents WHERE id = ?
      `).get(req.agent.id);

      inProgressCount = db.prepare(`
        SELECT COUNT(*) as count FROM tasks
        WHERE assigned_agent_id = ? AND status = 'in_progress'
      `).get(req.agent.id).count;

      if (inProgressCount >= (agent?.max_concurrent_tasks || 1)) {
        return response.success(res, {
          task: null,
          reason: 'concurrent_limit_reached',
          message: `Agent is at max concurrent tasks (${agent?.max_concurrent_tasks || 1})`
        });
      }

      // First, check for tasks already assigned to this agent
      task = db.prepare(`
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
      `).get(req.agent.id);

      // If no assigned task, look for unassigned tasks matching agent's capabilities
      if (!task) {
        // Get all unassigned pending tasks
        const unassignedTasks = db.prepare(`
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
        `).all(req.agent.id);

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

// ============================================
// Provider Configuration Endpoint
// This must come BEFORE /:id routes to avoid "providers" matching as an ID
// ============================================

/**
 * GET /api/agents/providers
 * List supported providers and their models
 */
router.get('/providers', userAuth, (req, res) => {
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
router.post('/match', userAuth, validateBody(matchAgentsSchema), (req, res) => {
  try {
    const { tags = [], priority, metadata = {} } = req.body;

    // Get all active agents with their details
    const agents = db.prepare(`
      SELECT
        id, name, type, description, capabilities, specializations, metadata, status,
        max_concurrent_tasks, active_task_count
      FROM agents
      WHERE status = 'active'
    `).all();

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

      // Check availability
      const available = agent.max_concurrent_tasks === null ||
        agent.active_task_count < agent.max_concurrent_tasks;

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
router.get('/', userAuth, (req, res) => {
  try {
    const { capability, status, available, business_line } = req.query;

    // Build query with filters
    let query = `
      SELECT
        id, name, type, description, capabilities, specializations, metadata, status,
        webhook_url, webhook_events, max_concurrent_tasks, active_task_count,
        execution_mode, owner_user_id,
        created_at, updated_at,
        (SELECT COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) FROM deliverables WHERE agent_id = agents.id) as total_tokens
      FROM agents
      WHERE 1=1
    `;
    const params = [];

    // Filter by status
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    // Filter by availability (active_task_count < max_concurrent_tasks or max_concurrent_tasks is null)
    if (available === 'true') {
      query += ' AND (max_concurrent_tasks IS NULL OR active_task_count < max_concurrent_tasks)';
    }

    query += ' ORDER BY created_at DESC';

    let agents = db.prepare(query).all(...params);

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
router.post('/', userAuth, requireRoles('admin'), validateBody(createAgentSchema), (req, res) => {
  try {
    const {
      name, type, description, capabilities, specializations, metadata, maxConcurrentTasks,
      agentType, specialization, projectAccess, taskTypes
    } = req.body;

    const result = db.prepare(`
      INSERT INTO agents (
        name, type, description, capabilities, specializations, metadata, max_concurrent_tasks,
        agent_type, specialization, project_access, task_types
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      type,
      description || null,
      JSON.stringify(capabilities),
      specializations ? JSON.stringify(specializations) : null,
      metadata ? JSON.stringify(metadata) : null,
      maxConcurrentTasks ?? 5,
      agentType || 'general',
      specialization || null,
      JSON.stringify(projectAccess || ['*']),
      JSON.stringify(taskTypes || ['*'])
    );

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(result.lastInsertRowid);

    // Note: agent.registered is a global event (not project-scoped)
    // Dispatch to all projects that have routes listening for this event
    const projectsWithAgentRoutes = db.prepare(`
      SELECT DISTINCT project_id FROM routes WHERE trigger_event = 'agent.registered' AND enabled = 1
    `).all();

    for (const { project_id } of projectsWithAgentRoutes) {
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(project_id);
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
router.get('/:id', userAuth, (req, res) => {
  try {
    const agent = db.prepare(`
      SELECT * FROM agents WHERE id = ?
    `).get(req.params.id);

    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    // Get API keys (without hash)
    const keys = db.prepare(`
      SELECT id, key_prefix, name, scopes, last_used_at, expires_at, revoked_at, created_at
      FROM agent_keys
      WHERE agent_id = ?
      ORDER BY created_at DESC
    `).all(req.params.id);

    response.success(res, normalizeAgentTimestamps({
      ...agent,
      keys: keys.map(k => normalizeKeyTimestamps({
        ...k,
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
router.get('/:id/metrics', userAuth, (req, res) => {
  try {
    const agent = db.prepare(`
      SELECT id, name FROM agents WHERE id = ?
    `).get(req.params.id);

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
    const taskStats = db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as tasks_completed,
        COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as tasks_in_progress,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as tasks_failed
      FROM tasks t
      WHERE t.assigned_agent_id = ?
      ${dateFilter}
    `).get(req.params.id);

    // Average completion time (only for tasks with both started_at and completed_at)
    const avgCompletionTime = db.prepare(`
      SELECT AVG(
        (julianday(completed_at) - julianday(started_at)) * 24 * 60
      ) as avg_minutes
      FROM tasks t
      WHERE t.assigned_agent_id = ?
        AND t.status = 'completed'
        AND t.started_at IS NOT NULL
        AND t.completed_at IS NOT NULL
        ${dateFilter}
    `).get(req.params.id);

    // Deliverable metrics
    const deliverableStats = db.prepare(`
      SELECT
        COUNT(*) as deliverables_submitted,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as deliverables_approved,
        COUNT(CASE WHEN status = 'revision_requested' THEN 1 END) as deliverables_revision_requested,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as deliverables_rejected
      FROM deliverables d
      WHERE d.agent_id = ?
      ${dateFilterDeliverables}
    `).get(req.params.id);

    // Token usage stats
    const tokenStats = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens
      FROM deliverables d
      WHERE d.agent_id = ?
      ${dateFilterDeliverables}
    `).get(req.params.id);

    // First-time approval rate (version = 1 and approved)
    const firstTimeApproval = db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'approved' AND version = 1 THEN 1 END) as first_time_approved,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as total_approved
      FROM deliverables d
      WHERE d.agent_id = ?
      ${dateFilterDeliverables}
    `).get(req.params.id);

    // Recent activity (last 7 days regardless of period filter)
    const recentActivity = db.prepare(`
      SELECT
        date(t.completed_at) as date,
        COUNT(t.id) as tasks_completed,
        0 as deliverables_submitted
      FROM tasks t
      WHERE t.assigned_agent_id = ?
        AND t.status = 'completed'
        AND t.completed_at >= datetime('now', '-7 days')
      GROUP BY date(t.completed_at)
    `).all(req.params.id);

    const recentDeliverables = db.prepare(`
      SELECT
        date(d.created_at) as date,
        COUNT(d.id) as deliverables_submitted
      FROM deliverables d
      WHERE d.agent_id = ?
        AND d.created_at >= datetime('now', '-7 days')
      GROUP BY date(d.created_at)
    `).all(req.params.id);

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
      if (activityMap.has(row.date)) {
        activityMap.get(row.date).tasks_completed = row.tasks_completed;
      }
    }

    // Fill in deliverable submissions
    for (const row of recentDeliverables) {
      if (activityMap.has(row.date)) {
        activityMap.get(row.date).deliverables_submitted = row.deliverables_submitted;
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
router.patch('/:id', userAuth, requireRoles('admin'), validateBody(updateAgentSchema), (req, res) => {
  try {
    const agent = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(req.params.id);
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

    db.prepare(`
      UPDATE agents SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);

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
router.delete('/:id', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    db.prepare('DELETE FROM agents WHERE id = ?').run(req.params.id);

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
router.post('/:id/keys', userAuth, requireRoles('admin'), keyGenLimiter, validateBody(generateKeySchema), (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const { name, scopes, expiresAt } = req.body;
    const { key, hash, prefix } = generateApiKey();

    const result = db.prepare(`
      INSERT INTO agent_keys (agent_id, key_hash, key_prefix, name, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      hash,
      prefix,
      name || null,
      JSON.stringify(scopes),
      expiresAt || null
    );

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
router.delete('/:id/keys/:keyId', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const key = db.prepare(`
      SELECT id FROM agent_keys WHERE id = ? AND agent_id = ?
    `).get(req.params.keyId, req.params.id);

    if (!key) {
      return response.notFound(res, 'API key');
    }

    db.prepare(`
      UPDATE agent_keys SET revoked_at = datetime('now') WHERE id = ?
    `).run(req.params.keyId);

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
router.post('/:id/webhook-secret', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const secret = generateWebhookSecret();

    db.prepare(`
      UPDATE agents SET webhook_secret = ?, updated_at = datetime('now') WHERE id = ?
    `).run(secret, req.params.id);

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
router.put('/:id/owner', userAuth, requireRoles('admin'), validateBody(updateAgentOwnerSchema), (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const { userId } = req.body;

    // Validate user exists if linking
    if (userId !== null && userId !== undefined) {
      const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
      if (!user) {
        return response.notFound(res, 'User');
      }
    }

    db.prepare(`
      UPDATE agents SET owner_user_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(userId || null, req.params.id);

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
router.post('/:id/test-connection', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const agent = db.prepare(`
      SELECT id, provider, provider_api_key_encrypted, provider_api_key_iv, provider_model
      FROM agents WHERE id = ?
    `).get(req.params.id);

    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    // Get API key from request body or decrypt from database
    let apiKey = req.body.apiKey;
    const provider = req.body.provider || agent.provider;
    const model = req.body.model || agent.provider_model;

    if (!apiKey && agent.provider_api_key_encrypted) {
      apiKey = decrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv);
    }

    if (!apiKey || !provider) {
      return response.badRequest(res, 'Provider and API key are required');
    }

    // Test the connection based on provider
    try {
      if (provider === 'anthropic') {
        const result = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: model || 'claude-sonnet-4-20250514',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Hi' }]
          })
        });

        if (result.ok) {
          return response.success(res, { success: true, message: 'Connection successful' });
        } else {
          const error = await result.json();
          return response.success(res, {
            success: false,
            message: error.error?.message || 'Connection failed'
          });
        }
      } else if (provider === 'openai') {
        const result = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model || 'gpt-4o',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Hi' }]
          })
        });

        if (result.ok) {
          return response.success(res, { success: true, message: 'Connection successful' });
        } else {
          const error = await result.json();
          return response.success(res, {
            success: false,
            message: error.error?.message || 'Connection failed'
          });
        }
      } else {
        return response.badRequest(res, `Unsupported provider: ${provider}`);
      }
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
router.post('/:id/execute', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const agent = db.prepare(`
      SELECT * FROM agents WHERE id = ?
    `).get(req.params.id);

    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    if (!agent.provider || !agent.provider_api_key_encrypted) {
      return response.badRequest(res, 'Agent execution not configured');
    }

    const { taskId } = req.body;
    if (!taskId) {
      return response.badRequest(res, 'taskId is required');
    }

    const task = db.prepare(`
      SELECT * FROM tasks WHERE id = ? AND assigned_agent_id = ?
    `).get(taskId, req.params.id);

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
router.patch('/:id/execution', userAuth, requireRoles('admin'), validateBody(updateAgentExecutionSchema), (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const {
      provider,
      providerApiKey,
      providerModel,
      systemPrompt,
      executionMode,
      maxTokens,
      temperature
    } = req.body;

    const updates = [];
    const values = [];

    if (provider !== undefined) {
      updates.push('provider = ?');
      values.push(provider || null);
    }

    if (providerApiKey !== undefined) {
      if (providerApiKey) {
        const { encrypted, iv } = encrypt(providerApiKey);
        updates.push('provider_api_key_encrypted = ?', 'provider_api_key_iv = ?');
        values.push(encrypted, iv);
      } else {
        updates.push('provider_api_key_encrypted = ?', 'provider_api_key_iv = ?');
        values.push(null, null);
      }
    }

    if (providerModel !== undefined) {
      updates.push('provider_model = ?');
      values.push(providerModel || null);
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

    db.prepare(`
      UPDATE agents SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    // When API key or provider is updated, clear execution errors on stuck tasks
    // so the dispatcher will retry them with the new credentials
    if (providerApiKey !== undefined || provider !== undefined) {
      const stuckTasks = db.prepare(`
        SELECT id, context FROM tasks
        WHERE assigned_agent_id = ? AND status = 'assigned' AND context IS NOT NULL
      `).all(req.params.id);

      let cleared = 0;
      for (const task of stuckTasks) {
        try {
          const ctx = JSON.parse(task.context || '{}');
          if (ctx.lastExecutionError) {
            delete ctx.lastExecutionError;
            db.prepare('UPDATE tasks SET context = ?, updated_at = datetime(\'now\') WHERE id = ?')
              .run(JSON.stringify(ctx), task.id);
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
