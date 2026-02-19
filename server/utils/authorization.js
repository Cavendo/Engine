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

import db from '../db/connection.js';

/**
 * Check if the current request has access to a task.
 * @param {Object} req - Express request (with req.user or req.agent)
 * @param {number} taskId - The task ID to check
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canAccessTask(req, taskId) {
  // Session users always have read access
  if (req.user) return { allowed: true };

  // User keys have full access
  if (req.agent?.isUserKey) return { allowed: true };

  // Agent keys: must be assigned to this task
  if (req.agent?.id) {
    const task = db.prepare('SELECT assigned_agent_id FROM tasks WHERE id = ?').get(taskId);
    if (!task) return { allowed: false, reason: 'not_found' };

    if (task.assigned_agent_id === req.agent.id) return { allowed: true };

    // Check delegated access (agent owned by same user)
    if (req.agent.ownerUserId && task.assigned_agent_id) {
      const assignedAgent = db.prepare('SELECT owner_user_id FROM agents WHERE id = ?').get(task.assigned_agent_id);
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
export function canAccessDeliverable(req, deliverableId) {
  // Session users always have read access
  if (req.user) return { allowed: true };

  // User keys have full access
  if (req.agent?.isUserKey) return { allowed: true };

  // Agent keys: must have submitted it OR it must be for a task assigned to them
  if (req.agent?.id) {
    const deliverable = db.prepare(`
      SELECT d.agent_id, d.task_id, t.assigned_agent_id
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ?
    `).get(deliverableId);

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
        const agent = db.prepare('SELECT owner_user_id FROM agents WHERE id = ?').get(agentId);
        if (agent && agent.owner_user_id === req.agent.ownerUserId) {
          return { allowed: true };
        }
      }
    }

    return { allowed: false, reason: 'forbidden' };
  }

  return { allowed: false, reason: 'forbidden' };
}
