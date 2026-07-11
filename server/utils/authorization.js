/**
 * Entity-level authorization helpers
 * Prevents IDOR by verifying the authenticated caller has access
 * to the specific resource they're requesting.
 *
 * Access rules:
 * - Session users: full read access (human reviewers/admins)
 * - User keys (cav_uk_): full access (acts as the user)
 * - Agent keys (cav_ak_): only tasks assigned to them and related resources
 */

import db from '../db/adapter.js';
import * as response from './response.js';

const HUMAN_READ_ROLES = ['admin', 'operator', 'reviewer', 'viewer'];

/**
 * Parse an agent project-access value. Missing values preserve the historic
 * wildcard default; malformed values fail closed.
 */
export function parseProjectAccess(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return { all: true, ids: [] };
  }

  const parsed = Array.isArray(rawValue)
    ? rawValue
    : (() => {
      try { return JSON.parse(rawValue); } catch { return null; }
    })();

  if (!Array.isArray(parsed)) return { all: false, ids: [] };
  const ids = parsed.map((value) => String(value || '').trim()).filter(Boolean);
  return { all: ids.includes('*'), ids: ids.filter((id) => id !== '*') };
}

export function isRegularAgentKey(req) {
  return Boolean(req.agent?.id && !req.agent?.isUserKey);
}

export function hasAgentScope(req, scope) {
  if (!isRegularAgentKey(req)) return false;
  const scopes = Array.isArray(req.agent.scopes) ? req.agent.scopes : [];
  return scopes.includes('*') || scopes.includes(scope);
}

/**
 * Human sessions and user keys are role-governed. Regular agent keys must
 * hold the requested generic read/write scope.
 */
export function requireActorAccess({ roles = HUMAN_READ_ROLES, agentScope = 'read' } = {}) {
  return (req, res, next) => {
    if (isRegularAgentKey(req)) {
      if (!hasAgentScope(req, agentScope)) {
        return response.forbidden(res, `Missing required scope: ${agentScope}`);
      }
      return next();
    }

    const role = req.user?.role || (req.agent?.isUserKey ? req.agent.userRole : null);
    if (!role) return response.unauthorized(res, 'Authentication required');
    if (!roles.includes(role)) return response.forbidden(res, 'Insufficient permissions');
    return next();
  };
}

export function hasProjectAccess(req, projectId) {
  if (!isRegularAgentKey(req) || projectId === null || projectId === undefined) return true;
  const access = parseProjectAccess(req.agent.projectAccess);
  return access.all || access.ids.includes(String(projectId));
}

/**
 * SQL fragment for project-scoped lists. Shared records without a project
 * remain visible only when explicitly requested by the caller.
 */
export function projectScopeFilter(req, column, { includeUnscoped = false } = {}) {
  if (!isRegularAgentKey(req)) return { sql: '', params: [] };
  const access = parseProjectAccess(req.agent.projectAccess);
  if (access.all) return { sql: '', params: [] };
  if (access.ids.length === 0) {
    return { sql: includeUnscoped ? `${column} IS NULL` : '1 = 0', params: [] };
  }
  const scoped = `${column} IN (${access.ids.map(() => '?').join(', ')})`;
  return {
    sql: includeUnscoped ? `(${column} IS NULL OR ${scoped})` : scoped,
    params: access.ids
  };
}

/**
 * Check if the current request has access to a task.
 * @param {Object} req - Express request (with req.user or req.agent)
 * @param {number} taskId - The task ID to check
 * @returns {{ allowed: boolean, reason?: string }}
 */
export async function canAccessTask(req, taskId) {
  // Session users always have read access
  if (req.user) return { allowed: true };

  // User keys have full access
  if (req.agent?.isUserKey) return { allowed: true };

  // Agent keys: must be assigned to this task
  if (req.agent?.id) {
    const task = await db.one('SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId]);
    if (!task) return { allowed: false, reason: 'not_found' };

    if (task.assigned_agent_id === req.agent.id) return { allowed: true };

    // Check delegated access (agent owned by same user)
    if (req.agent.ownerUserId && task.assigned_agent_id) {
      const assignedAgent = await db.one('SELECT owner_user_id FROM agents WHERE id = ?', [task.assigned_agent_id]);
      if (assignedAgent && assignedAgent.owner_user_id === req.agent.ownerUserId) {
        return { allowed: true };
      }
    }

    return { allowed: false, reason: 'forbidden' };
  }

  return { allowed: false, reason: 'forbidden' };
}

/**
 * Check if the current request has access to a deliverable.
 * @param {Object} req - Express request
 * @param {number} deliverableId - The deliverable ID to check
 * @returns {{ allowed: boolean, reason?: string }}
 */
export async function canAccessDeliverable(req, deliverableId) {
  // Session users always have read access
  if (req.user) return { allowed: true };

  // User keys have full access
  if (req.agent?.isUserKey) return { allowed: true };

  // Agent keys: must have submitted it OR it must be for a task assigned to them
  if (req.agent?.id) {
    const deliverable = await db.one(`
      SELECT d.agent_id, d.task_id, t.assigned_agent_id
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ?
    `, [deliverableId]);

    if (!deliverable) return { allowed: false, reason: 'not_found' };

    // Agent submitted this deliverable
    if (deliverable.agent_id === req.agent.id) return { allowed: true };

    // Task is assigned to this agent
    if (deliverable.assigned_agent_id === req.agent.id) return { allowed: true };

    // Delegated access
    if (req.agent.ownerUserId) {
      const agentIds = [];
      if (deliverable.agent_id) agentIds.push(deliverable.agent_id);
      if (deliverable.assigned_agent_id) agentIds.push(deliverable.assigned_agent_id);

      for (const agentId of agentIds) {
        const agent = await db.one('SELECT owner_user_id FROM agents WHERE id = ?', [agentId]);
        if (agent && agent.owner_user_id === req.agent.ownerUserId) {
          return { allowed: true };
        }
      }
    }

    return { allowed: false, reason: 'forbidden' };
  }

  return { allowed: false, reason: 'forbidden' };
}
