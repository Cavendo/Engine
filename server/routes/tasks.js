import { Router } from 'express';
import db from '../db/adapter.js';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { agentAuth, dualAuth, logAgentActivity } from '../middleware/agentAuth.js';
import { triggerWebhook } from '../services/webhooks.js';
import { dispatchEvent } from '../services/routeDispatcher.js';
import { logActivity } from '../services/activityLogger.js';
import { canAccessTask } from '../utils/authorization.js';
import {
  evaluateRoutingRules,
  incrementActiveTaskCount,
  decrementActiveTaskCount,
  reserveAgentCapacity
} from '../services/taskRouter.js';
import {
  validateBody,
  createTaskSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
  logTaskProgressSchema,
  bulkCreateTasksSchema,
  bulkUpdateTasksSchema,
  bulkDeleteTasksSchema
} from '../utils/validation.js';

const router = Router();

/**
 * Build assignee info for task.assigned event dispatch.
 * Includes the agent's linked user email so email routes can use {{assignee.email}}.
 */
async function buildAssigneeInfo(agentId) {
  if (!agentId) return null;
  const agent = await db.one('SELECT id, name, execution_mode, owner_user_id FROM agents WHERE id = ?', [agentId]);
  if (!agent) return { id: agentId };
  const info = { id: agent.id, name: agent.name, executionMode: agent.execution_mode };
  if (agent.owner_user_id) {
    const user = await db.one('SELECT email, name FROM users WHERE id = ?', [agent.owner_user_id]);
    if (user) {
      info.email = user.email;
      info.userName = user.name;
    }
  }
  return info;
}

/**
 * Safely parse JSON with a default fallback
 */
function safeJsonParse(val, defaultValue = null) {
  if (val === null || val === undefined) return defaultValue;
  if (typeof val !== 'string') return val; // already parsed
  try {
    return JSON.parse(val);
  } catch {
    // If defaultValue is an array and val looks like a comma-separated string, split it
    if (Array.isArray(defaultValue) && val.length > 0) {
      return val.split(',').map(s => s.trim()).filter(Boolean);
    }
    return defaultValue;
  }
}

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
 * Normalize timestamp and JSON fields on a task object
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

// ============================================
// Admin endpoints (require user authentication)
// ============================================

/**
 * GET /api/tasks
 * List all tasks with filtering
 */
router.get('/', userAuth, async (req, res) => {
  try {
    const { status, priority, projectId, agentId, sprintId } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = `
      SELECT
        t.*,
        p.name as project_name,
        a.name as agent_name,
        s.name as sprint_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN agents a ON a.id = t.assigned_agent_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND t.status = ?';
      params.push(status);
    }
    if (priority) {
      query += ' AND t.priority = ?';
      params.push(parseInt(priority));
    }
    if (projectId) {
      query += ' AND t.project_id = ?';
      params.push(parseInt(projectId));
    }
    if (agentId) {
      query += ' AND t.assigned_agent_id = ?';
      params.push(parseInt(agentId));
    }
    if (sprintId) {
      query += ' AND t.sprint_id = ?';
      params.push(parseInt(sprintId));
    }

    query += ' ORDER BY t.priority ASC, t.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const tasks = await db.many(query, params);

    const parsed = tasks.map(task => normalizeTaskTimestamps(task));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error listing tasks:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/tasks
 * Create a new task
 * Supports both user auth (session/user keys) and agent auth (agent keys)
 *
 * If no assignedAgentId is provided but projectId is, the task router
 * will evaluate routing rules to automatically assign an agent.
 */
router.post('/', dualAuth, validateBody(createTaskSchema), async (req, res) => {
  try {
    const {
      title, description, projectId, sprintId, assignedAgentId,
      priority, tags, context, dueDate,
      taskType, requiredCapabilities, preferredAgentId
    } = req.body;

    const isAutoAssign = assignedAgentId === 'auto';

    // Validate agent exists if directly assigned (not 'auto')
    if (assignedAgentId && !isAutoAssign) {
      const agent = await db.one('SELECT id FROM agents WHERE id = ?', [assignedAgentId]);
      if (!agent) {
        return response.validationError(res, 'Invalid agent ID');
      }
    }

    // Validate project exists if provided
    if (projectId) {
      const project = await db.one('SELECT id FROM projects WHERE id = ?', [projectId]);
      if (!project) {
        return response.validationError(res, 'Invalid project ID');
      }
    }

    // Validate sprint exists if provided
    if (sprintId) {
      const sprint = await db.one('SELECT id FROM sprints WHERE id = ?', [sprintId]);
      if (!sprint) {
        return response.validationError(res, 'Invalid sprint ID');
      }
    }

    // Determine assignment: use provided agent or run routing rules
    let finalAgentId = (assignedAgentId && !isAutoAssign) ? assignedAgentId : null;
    let routingRuleId = null;
    let routingDecision = null;

    // Auto-assign: evaluate routing rules when 'auto' and project exists (read-only)
    let candidateAgentId = null;
    if (isAutoAssign && projectId) {
      const taskData = {
        tags: tags || [],
        priority: priority || 2,
        context: context || {},
        requiredCapabilities: requiredCapabilities || [],
        preferredAgentId: preferredAgentId || null
      };

      const routingResult = await evaluateRoutingRules(projectId, taskData);

      if (routingResult.matched && routingResult.agentId) {
        candidateAgentId = routingResult.agentId;
        routingRuleId = routingResult.ruleId || null;
        routingDecision = routingResult.decision;
      } else {
        routingDecision = routingResult.decision;
      }
    }

    // Reservation + task INSERT in same transaction (Issue #18)
    let result;
    if (candidateAgentId) {
      result = await db.tx(async (tx) => {
        const reservation = await reserveAgentCapacity(candidateAgentId, tx);
        if (reservation.ok) {
          finalAgentId = candidateAgentId;
        } else {
          // Capacity race — treat as routing miss
          finalAgentId = null;
          routingDecision = reservation.reason;
        }

        const status = finalAgentId ? 'assigned' : 'pending';
        return await tx.insert(`
          INSERT INTO tasks (
            title, description, project_id, sprint_id, assigned_agent_id,
            status, priority, tags, context, due_date, assigned_at,
            routing_rule_id, routing_decision,
            task_type, required_capabilities, preferred_agent_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          title,
          description || null,
          projectId || null,
          sprintId || null,
          finalAgentId,
          status,
          priority || 2,
          JSON.stringify(tags || []),
          JSON.stringify(context || {}),
          dueDate || null,
          finalAgentId ? new Date().toISOString() : null,
          routingRuleId,
          routingDecision,
          taskType || null,
          JSON.stringify(requiredCapabilities || []),
          preferredAgentId || null
        ]);
      });
    } else {
      // No candidate (direct assignment or no routing match) — no reservation needed
      const status = finalAgentId ? 'assigned' : 'pending';
      result = await db.insert(`
        INSERT INTO tasks (
          title, description, project_id, sprint_id, assigned_agent_id,
          status, priority, tags, context, due_date, assigned_at,
          routing_rule_id, routing_decision,
          task_type, required_capabilities, preferred_agent_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        title,
        description || null,
        projectId || null,
        sprintId || null,
        finalAgentId,
        status,
        priority || 2,
        JSON.stringify(tags || []),
        JSON.stringify(context || {}),
        dueDate || null,
        finalAgentId ? new Date().toISOString() : null,
        routingRuleId,
        routingDecision,
        taskType || null,
        JSON.stringify(requiredCapabilities || []),
        preferredAgentId || null
      ]);
      // Direct assignment bypasses capacity check (admin override)
      if (finalAgentId) {
        await incrementActiveTaskCount(finalAgentId);
      }
    }

    const task = await db.one('SELECT * FROM tasks WHERE id = ?', [result.lastInsertRowid]);

    // Log activity
    const creatorName = req.user?.name || req.user?.email || req.agent?.name || 'system';
    logActivity('task', task.id, 'created', creatorName, { title });
    if (finalAgentId) {
      const assignedAgent = await db.one('SELECT name FROM agents WHERE id = ?', [finalAgentId]);
      logActivity('task', task.id, 'assigned', creatorName, { assigned_to: assignedAgent?.name || `agent:${finalAgentId}` });
    }
    if (!finalAgentId && routingDecision) {
      logActivity('task', task.id, 'routing_failed', 'system', {
        decision: routingDecision,
        projectId
      });
    }

    // Trigger webhook if assigned
    if (finalAgentId) {
      triggerWebhook(finalAgentId, 'task.assigned', {
        task: { ...task, context: safeJsonParse(task.context, {}), tags: safeJsonParse(task.tags, []) }
      });
    }

    // Dispatch delivery route events (if project-scoped)
    if (projectId) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [projectId]);
      const taskPayload = {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        tags: safeJsonParse(task.tags, []),
        assigned_agent_id: task.assigned_agent_id,
        due_date: task.due_date
      };
      dispatchEvent('task.created', {
        project: project ? { id: project.id, name: project.name } : { id: projectId },
        projectId,
        task: taskPayload,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Tasks] Route dispatch error:', err));

      // Dispatch task.assigned event for delivery routes (e.g., notify human agents)
      if (finalAgentId) {
        const assignee = await buildAssigneeInfo(finalAgentId);
        dispatchEvent('task.assigned', {
          project: project ? { id: project.id, name: project.name } : { id: projectId },
          projectId,
          task: taskPayload,
          agent: assignee,
          assignee,
          timestamp: new Date().toISOString()
        }).catch(err => console.error('[Tasks] Route dispatch error:', err));
      }
    }

    // Dispatch task.routing_failed event if routing didn't find an agent
    if (!finalAgentId && projectId && routingDecision) {
      const projectForRouting = await db.one('SELECT id, name FROM projects WHERE id = ?', [projectId]);
      dispatchEvent('task.routing_failed', {
        project: projectForRouting ? { id: projectForRouting.id, name: projectForRouting.name } : { id: projectId },
        projectId,
        task: {
          id: task.id,
          title,
          status: 'pending',
          priority: priority || 2
        },
        reason: routingDecision,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Tasks] Route dispatch error:', err));
    }

    // Build response with routing metadata when auto-assign was attempted
    const taskData = normalizeTaskTimestamps(task);
    const autoAssignAttempted = isAutoAssign && !!projectId;

    if (autoAssignAttempted) {
      // needsConfiguration = true only when routing is genuinely unconfigured,
      // NOT when agents exist but are at capacity/disabled/unavailable.
      const isUnconfigured = !routingDecision ||
        routingDecision === 'No matching rule and no default agent configured';
      const needsConfiguration = !finalAgentId && isUnconfigured;
      taskData.routing = {
        attempted: true,
        matched: !!finalAgentId,
        assignedAgentId: finalAgentId,
        decision: routingDecision,
        needsConfiguration
      };
    }

    response.created(res, taskData);
  } catch (err) {
    console.error('Error creating task:', err);
    response.serverError(res);
  }
});

// ============================================
// Bulk operations (must be BEFORE /:id routes)
// ============================================

/**
 * POST /api/tasks/bulk
 * Bulk create tasks (max 50 per request)
 * Supports automatic routing when no assignedAgentId is provided
 */
router.post('/bulk', userAuth, requireRoles('admin'), validateBody(bulkCreateTasksSchema), async (req, res) => {
  const { tasks } = req.body;
  const results = [];
  const errors = [];

  try {
    // Wrap in transaction for atomicity
    await db.tx(async (tx) => {
      for (let i = 0; i < tasks.length; i++) {
        const taskData = tasks[i];
        try {
          const {
            title, description, projectId, sprintId, assignedAgentId,
            priority, tags, context, dueDate
          } = taskData;

          const isBulkAutoAssign = assignedAgentId === 'auto';

          // Validate agent exists if directly assigned (not 'auto')
          if (assignedAgentId && !isBulkAutoAssign) {
            const agent = await tx.one('SELECT id FROM agents WHERE id = ?', [assignedAgentId]);
            if (!agent) {
              errors.push({ index: i, title, error: 'Invalid agent ID' });
              continue;
            }
          }

          // Validate project exists if provided
          if (projectId) {
            const project = await tx.one('SELECT id FROM projects WHERE id = ?', [projectId]);
            if (!project) {
              errors.push({ index: i, title, error: 'Invalid project ID' });
              continue;
            }
          }

          // Validate sprint exists if provided
          if (sprintId) {
            const sprint = await tx.one('SELECT id FROM sprints WHERE id = ?', [sprintId]);
            if (!sprint) {
              errors.push({ index: i, title, error: 'Invalid sprint ID' });
              continue;
            }
          }

          // Determine assignment: use provided agent or run routing rules
          let finalAgentId = (assignedAgentId && !isBulkAutoAssign) ? assignedAgentId : null;
          let routingRuleId = null;
          let routingDecision = null;

          // Auto-assign: evaluate routing rules when 'auto' and project exists
          if (isBulkAutoAssign && projectId) {
            const routingTaskData = {
              tags: tags || [],
              priority: priority || 2,
              context: context || {},
              requiredCapabilities: taskData.requiredCapabilities || [],
              preferredAgentId: taskData.preferredAgentId || null
            };

            const routingResult = await evaluateRoutingRules(projectId, routingTaskData);

            if (routingResult.matched && routingResult.agentId) {
              // Atomic capacity reservation (Issue #18)
              const reservation = await reserveAgentCapacity(routingResult.agentId, tx);
              if (reservation.ok) {
                finalAgentId = routingResult.agentId;
                routingRuleId = routingResult.ruleId || null;
                routingDecision = routingResult.decision;
              } else {
                // Capacity race — treat as routing miss for this task
                routingDecision = reservation.reason;
              }
            } else {
              routingDecision = routingResult.decision;
            }
          } else if (finalAgentId) {
            // Direct assignment bypasses capacity check (admin override)
            await incrementActiveTaskCount(finalAgentId, tx);
          }

          const status = finalAgentId ? 'assigned' : 'pending';

          const result = await tx.insert(`
            INSERT INTO tasks (
              title, description, project_id, sprint_id, assigned_agent_id,
              status, priority, tags, context, due_date, assigned_at,
              routing_rule_id, routing_decision
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            title,
            description || null,
            projectId || null,
            sprintId || null,
            finalAgentId,
            status,
            priority || 2,
            JSON.stringify(tags || []),
            JSON.stringify(context || {}),
            dueDate || null,
            finalAgentId ? new Date().toISOString() : null,
            routingRuleId,
            routingDecision
          ]);

          const task = await tx.one('SELECT * FROM tasks WHERE id = ?', [result.lastInsertRowid]);
          results.push(normalizeTaskTimestamps(task));

          // Trigger webhook if assigned
          if (finalAgentId) {
            triggerWebhook(finalAgentId, 'task.assigned', {
              task: { ...task, context: safeJsonParse(task.context, {}), tags: safeJsonParse(task.tags, []) }
            });
          }

          // Dispatch delivery route events (if project-scoped)
          if (projectId) {
            const projectForEvent = await tx.one('SELECT id, name FROM projects WHERE id = ?', [projectId]);
            const taskPayload = {
              id: task.id,
              title: task.title,
              description: task.description,
              status: task.status,
              priority: task.priority,
              tags: safeJsonParse(task.tags, []),
              assigned_agent_id: task.assigned_agent_id,
              due_date: task.due_date
            };
            dispatchEvent('task.created', {
              project: projectForEvent ? { id: projectForEvent.id, name: projectForEvent.name } : { id: projectId },
              projectId,
              task: taskPayload,
              timestamp: new Date().toISOString()
            }).catch(err => console.error('[Tasks] Route dispatch error:', err));

            if (finalAgentId) {
              const assignee = await buildAssigneeInfo(finalAgentId);
              dispatchEvent('task.assigned', {
                project: projectForEvent ? { id: projectForEvent.id, name: projectForEvent.name } : { id: projectId },
                projectId,
                task: taskPayload,
                agent: assignee,
                assignee,
                timestamp: new Date().toISOString()
              }).catch(err => console.error('[Tasks] Route dispatch error:', err));
            }
          }
        } catch (err) {
          errors.push({ index: i, title: taskData.title, error: err.message });
        }
      }
    });

    response.created(res, {
      created: results,
      errors,
      summary: {
        total: tasks.length,
        successful: results.length,
        failed: errors.length
      }
    });
  } catch (err) {
    console.error('Error bulk creating tasks:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/tasks/bulk
 * Bulk update tasks (max 100 per request)
 * Handles agent task count management when reassigning or completing tasks
 */
router.patch('/bulk', userAuth, requireRoles('admin'), validateBody(bulkUpdateTasksSchema), async (req, res) => {
  const { taskIds, updates } = req.body;
  let updatedCount = 0;
  const errors = [];

  // Build update query
  const updateParts = [];
  const updateValues = [];

  if (updates.status !== undefined) {
    updateParts.push('status = ?');
    updateValues.push(updates.status);

    // Handle timestamp updates based on status
    if (updates.status === 'in_progress') {
      updateParts.push("started_at = COALESCE(started_at, datetime('now'))");
    }
    if (updates.status === 'completed') {
      updateParts.push("completed_at = COALESCE(completed_at, datetime('now'))");
    }
  }
  if (updates.priority !== undefined) {
    updateParts.push('priority = ?');
    updateValues.push(updates.priority);
  }
  if (updates.projectId !== undefined) {
    updateParts.push('project_id = ?');
    updateValues.push(updates.projectId);
  }
  if (updates.sprintId !== undefined) {
    updateParts.push('sprint_id = ?');
    updateValues.push(updates.sprintId);
  }
  if (updates.assignedAgentId !== undefined) {
    updateParts.push('assigned_agent_id = ?');
    updateValues.push(updates.assignedAgentId);
    if (updates.assignedAgentId) {
      updateParts.push("assigned_at = COALESCE(assigned_at, datetime('now'))");
    }
  }
  if (updates.dueDate !== undefined) {
    updateParts.push('due_date = ?');
    updateValues.push(updates.dueDate);
  }

  updateParts.push("updated_at = datetime('now')");

  // Track tasks that had status changes for event dispatch
  let statusChangedTasks = [];
  // Track tasks that were reassigned for task.assigned dispatch
  let reassignedTasks = [];

  try {
    // Wrap in transaction for atomicity
    await db.tx(async (tx) => {
      // Get existing tasks with their current agent assignments and status
      const existingTasks = await tx.many(`
        SELECT id, assigned_agent_id, status, project_id FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')})
      `, taskIds);

      const existingTaskMap = new Map(existingTasks.map(t => [t.id, t]));

      for (const id of taskIds) {
        if (!existingTaskMap.has(id)) {
          errors.push({ taskId: id, error: 'Task not found' });
        }
      }

      // Track agent task count changes
      const agentCountChanges = new Map(); // agentId -> delta

      // Calculate task count changes before update and track status changes
      for (const task of existingTasks) {
        const oldAgentId = task.assigned_agent_id;
        const oldStatus = task.status;
        const newAgentId = updates.assignedAgentId !== undefined ? updates.assignedAgentId : oldAgentId;
        const newStatus = updates.status !== undefined ? updates.status : oldStatus;

        // Track status changes for event dispatch (only if project-scoped)
        if (updates.status !== undefined && updates.status !== oldStatus && task.project_id) {
          statusChangedTasks.push({
            taskId: task.id,
            projectId: task.project_id,
            oldStatus: oldStatus,
            newStatus: updates.status
          });
        }

        // Handle agent reassignment
        if (updates.assignedAgentId !== undefined && newAgentId !== oldAgentId) {
          // Track for task.assigned event dispatch
          if (newAgentId && task.project_id) {
            reassignedTasks.push({
              taskId: task.id,
              projectId: task.project_id,
              newAgentId: newAgentId,
              title: task.title || `Task #${task.id}`
            });
          }
          // Decrement old agent count
          if (oldAgentId && oldStatus !== 'completed' && oldStatus !== 'cancelled') {
            agentCountChanges.set(oldAgentId, (agentCountChanges.get(oldAgentId) || 0) - 1);
          }
          // Increment new agent count (only if task is not completed/cancelled)
          if (newAgentId && newStatus !== 'completed' && newStatus !== 'cancelled') {
            agentCountChanges.set(newAgentId, (agentCountChanges.get(newAgentId) || 0) + 1);
          }
        }

        // Handle status changes affecting active task count
        if (updates.status !== undefined) {
          const terminalStatuses = ['completed', 'cancelled'];
          const activeStatuses = ['in_progress'];
          const oldWasTerminal = terminalStatuses.includes(oldStatus);
          const newIsTerminal = terminalStatuses.includes(newStatus);
          const newIsActive = activeStatuses.includes(newStatus);

          // If task moved FROM terminal TO active status, increment active count
          if (oldWasTerminal && newIsActive) {
            const agentId = newAgentId || oldAgentId;
            if (agentId) {
              agentCountChanges.set(agentId, (agentCountChanges.get(agentId) || 0) + 1);
            }
          }
          // If task moved FROM active TO terminal status, decrement active count
          else if (!oldWasTerminal && newIsTerminal) {
            const agentId = newAgentId || oldAgentId;
            if (agentId) {
              agentCountChanges.set(agentId, (agentCountChanges.get(agentId) || 0) - 1);
            }
          }
        }
      }

      // Only update existing tasks
      const validIds = taskIds.filter(id => existingTaskMap.has(id));

      if (validIds.length > 0) {
        const placeholders = validIds.map(() => '?').join(',');
        const result = await tx.exec(`
          UPDATE tasks
          SET ${updateParts.join(', ')}
          WHERE id IN (${placeholders})
        `, [...updateValues, ...validIds]);

        updatedCount = result.changes;

        // Apply agent task count changes
        for (const [agentId, delta] of agentCountChanges) {
          if (delta > 0) {
            // Increment
            await tx.exec(`
              UPDATE agents
              SET active_task_count = COALESCE(active_task_count, 0) + ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `, [delta, agentId]);
          } else if (delta < 0) {
            // Decrement (ensure non-negative)
            await tx.exec(`
              UPDATE agents
              SET active_task_count = MAX(0, COALESCE(active_task_count, 0) + ?),
                  updated_at = datetime('now')
              WHERE id = ?
            `, [delta, agentId]);
          }
        }
      }
    });

    // Dispatch task.status_changed events for tasks that had status changes
    for (const change of statusChangedTasks) {
      const updatedTask = await db.one('SELECT * FROM tasks WHERE id = ?', [change.taskId]);
      if (updatedTask) {
        const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [change.projectId]);
        const assignee = updatedTask.assigned_agent_id ? await buildAssigneeInfo(updatedTask.assigned_agent_id) : null;
        dispatchEvent('task.status_changed', {
          project: project ? { id: project.id, name: project.name } : { id: change.projectId },
          projectId: change.projectId,
          task: {
            id: updatedTask.id,
            title: updatedTask.title,
            description: updatedTask.description,
            status: updatedTask.status,
            priority: updatedTask.priority,
            tags: safeJsonParse(updatedTask.tags, []),
            assigned_agent_id: updatedTask.assigned_agent_id,
            due_date: updatedTask.due_date
          },
          agent: assignee,
          assignee,
          old_status: change.oldStatus,
          new_status: change.newStatus,
          timestamp: new Date().toISOString()
        }).catch(err => console.error('[Tasks] Route dispatch error:', err));

        // Also fire task.completed as a convenience event
        if (change.newStatus === 'completed') {
          dispatchEvent('task.completed', {
            project: project ? { id: project.id, name: project.name } : { id: change.projectId },
            projectId: change.projectId,
            task: {
              id: updatedTask.id, title: updatedTask.title, description: updatedTask.description,
              status: updatedTask.status, priority: updatedTask.priority,
              tags: safeJsonParse(updatedTask.tags, []),
              assigned_agent_id: updatedTask.assigned_agent_id, due_date: updatedTask.due_date
            },
            agent: assignee, assignee,
            timestamp: new Date().toISOString()
          }).catch(err => console.error('[Tasks] Route dispatch error:', err));
        }
      }
    }

    // Dispatch task.assigned events for reassigned tasks
    for (const reassign of reassignedTasks) {
      const updatedTask = await db.one('SELECT * FROM tasks WHERE id = ?', [reassign.taskId]);
      if (updatedTask) {
        const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [reassign.projectId]);
        const assignee = await buildAssigneeInfo(reassign.newAgentId);
        dispatchEvent('task.assigned', {
          project: project ? { id: project.id, name: project.name } : { id: reassign.projectId },
          projectId: reassign.projectId,
          task: {
            id: updatedTask.id,
            title: updatedTask.title,
            description: updatedTask.description,
            status: updatedTask.status,
            priority: updatedTask.priority,
            assigned_agent_id: updatedTask.assigned_agent_id,
            assigned_agent_name: assignee?.name || 'agent'
          },
          agent: assignee,
          assignee,
          assigned_by: 'bulk_update',
          timestamp: new Date().toISOString()
        }).catch(err => console.error('[Tasks] Route dispatch error:', err));
      }
    }

    response.success(res, {
      updated: updatedCount,
      errors,
      summary: {
        requested: taskIds.length,
        successful: updatedCount,
        failed: errors.length
      }
    });
  } catch (err) {
    console.error('Error bulk updating tasks:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/tasks/bulk
 * Bulk delete tasks (max 100 per request)
 * Decrements agent task counts for active assigned tasks
 */
router.delete('/bulk', userAuth, requireRoles('admin'), validateBody(bulkDeleteTasksSchema), async (req, res) => {
  const { taskIds } = req.body;
  let deletedCount = 0;
  const errors = [];

  // Track deleted tasks for event dispatch
  let deletedTasksForDispatch = [];

  try {
    // Wrap in transaction for atomicity
    await db.tx(async (tx) => {
      // Get existing tasks with agent assignments
      const existingTasks = await tx.many(`
        SELECT id, title, description, assigned_agent_id, status, priority, project_id, tags FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')})
      `, taskIds);

      const existingIds = new Set(existingTasks.map(t => t.id));

      for (const id of taskIds) {
        if (!existingIds.has(id)) {
          errors.push({ taskId: id, error: 'Task not found' });
        }
      }

      // Calculate agent count decrements for active tasks being deleted
      const agentDecrements = new Map();
      for (const task of existingTasks) {
        // Only decrement if task has an agent and is not already completed/cancelled
        if (task.assigned_agent_id && task.status !== 'completed' && task.status !== 'cancelled') {
          agentDecrements.set(
            task.assigned_agent_id,
            (agentDecrements.get(task.assigned_agent_id) || 0) + 1
          );
        }
      }

      // Only delete existing tasks
      const validIds = taskIds.filter(id => existingIds.has(id));

      // Capture task data for event dispatch before deletion
      deletedTasksForDispatch = existingTasks.filter(t => t.project_id);

      if (validIds.length > 0) {
        const placeholders = validIds.map(() => '?').join(',');
        const result = await tx.exec(`DELETE FROM tasks WHERE id IN (${placeholders})`, validIds);
        deletedCount = result.changes;

        // Apply agent task count decrements
        for (const [agentId, count] of agentDecrements) {
          await tx.exec(`
            UPDATE agents
            SET active_task_count = MAX(0, COALESCE(active_task_count, 0) - ?),
                updated_at = datetime('now')
            WHERE id = ?
          `, [count, agentId]);
        }
      }
    });

    // Dispatch task.status_changed events for deleted tasks
    for (const task of deletedTasksForDispatch) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [task.project_id]);
      const assignee = task.assigned_agent_id ? await buildAssigneeInfo(task.assigned_agent_id) : null;
      dispatchEvent('task.status_changed', {
        project: project ? { id: project.id, name: project.name } : { id: task.project_id },
        projectId: task.project_id,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          status: 'deleted',
          priority: task.priority,
          tags: safeJsonParse(task.tags, []),
          assigned_agent_id: task.assigned_agent_id
        },
        agent: assignee,
        assignee,
        old_status: task.status,
        new_status: 'deleted',
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Tasks] Route dispatch error:', err));
    }

    response.success(res, {
      deleted: deletedCount,
      errors,
      summary: {
        requested: taskIds.length,
        successful: deletedCount,
        failed: errors.length
      }
    });
  } catch (err) {
    console.error('Error bulk deleting tasks:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/tasks/:id
 * Get task details
 * Supports both user auth (session/user keys) and agent auth (agent keys)
 */
router.get('/:id', dualAuth, async (req, res) => {
  try {
    // Authorization check
    const access = canAccessTask(req, req.params.id);
    if (!access.allowed) {
      return access.reason === 'not_found'
        ? response.notFound(res, 'Task')
        : response.forbidden(res, 'Access denied');
    }

    const task = await db.one(`
      SELECT
        t.*,
        p.name as project_name,
        a.name as agent_name,
        s.name as sprint_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN agents a ON a.id = t.assigned_agent_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE t.id = ?
    `, [req.params.id]);

    if (!task) {
      return response.notFound(res, 'Task');
    }

    // Get deliverables for this task
    const deliverables = (await db.many(`
      SELECT id, title, status, version, created_at
      FROM deliverables
      WHERE task_id = ?
      ORDER BY version DESC
    `, [req.params.id])).map(d => ({
      ...d,
      created_at: toISOTimestamp(d.created_at)
    }));

    response.success(res, normalizeTaskTimestamps({
      ...task,
      deliverables
    }));
  } catch (err) {
    console.error('Error getting task:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/tasks/:id/context
 * Get full context bundle for a task (for agent consumption)
 * Includes agent profile with system prompt and instructions
 */
router.get('/:id/context', dualAuth, async (req, res) => {
  try {
    const task = await db.one(`
      SELECT t.*, p.id as project_id, p.name as project_name, s.id as sprint_id, s.name as sprint_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN sprints s ON s.id = t.sprint_id
      WHERE t.id = ?
    `, [req.params.id]);

    if (!task) {
      return response.notFound(res, 'Task');
    }

    // Authorization check
    if (req.agent) {
      if (req.agent.isUserKey) {
        // User keys inherit the user's role — only admin/reviewer can access task context
        if (!req.agent.userRole || !['admin', 'reviewer'].includes(req.agent.userRole)) {
          return response.forbidden(res, 'Insufficient role for task context access');
        }
      } else {
        // Agent key: verify this task is assigned to them OR to an agent they own
        if (task.assigned_agent_id !== req.agent.id) {
          // Check if agent owns the assigned agent (for delegated access)
          if (req.agent.ownerUserId && task.assigned_agent_id) {
            const assignedAgent = await db.one('SELECT owner_user_id FROM agents WHERE id = ?', [task.assigned_agent_id]);
            if (!assignedAgent || assignedAgent.owner_user_id !== req.agent.ownerUserId) {
              return response.forbidden(res, 'Task not assigned to this agent');
            }
          } else {
            return response.forbidden(res, 'Task not assigned to this agent');
          }
        }
      }
    } else if (req.user) {
      // User auth: must be admin to access task context
      if (req.user.role !== 'admin') {
        return response.forbidden(res, 'Admin access required');
      }
    }

    // Get agent profile if task is assigned
    let agentProfile = null;
    if (task.assigned_agent_id) {
      const agent = await db.one(`
        SELECT id, name, type, description, capabilities, specializations, system_prompt, metadata
        FROM agents
        WHERE id = ?
      `, [task.assigned_agent_id]);

      if (agent) {
        agentProfile = {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          description: agent.description,
          capabilities: safeJsonParse(agent.capabilities, []),
          specializations: safeJsonParse(agent.specializations, {}),
          systemPrompt: agent.system_prompt,
          metadata: safeJsonParse(agent.metadata, {})
        };
      }
    }

    // Get project knowledge
    let knowledge = [];
    if (task.project_id) {
      knowledge = await db.many(`
        SELECT id, title, content, content_type, category, tags
        FROM knowledge
        WHERE project_id = ?
        ORDER BY created_at DESC
      `, [task.project_id]);

      knowledge = knowledge.map(k => ({
        ...k,
        tags: safeJsonParse(k.tags, [])
      }));
    }

    // Get previous deliverables and feedback
    const deliverables = (await db.many(`
      SELECT id, title, content, content_type, status, version, feedback, created_at
      FROM deliverables
      WHERE task_id = ?
      ORDER BY version DESC
    `, [req.params.id])).map(d => ({
      ...d,
      created_at: toISOTimestamp(d.created_at)
    }));

    // Get related tasks (same project)
    let relatedTasks = [];
    if (task.project_id) {
      relatedTasks = await db.many(`
        SELECT id, title, status, priority
        FROM tasks
        WHERE project_id = ? AND id != ?
        ORDER BY priority ASC, created_at DESC
        LIMIT 10
      `, [task.project_id, req.params.id]);
    }

    response.success(res, {
      task: normalizeTaskTimestamps(task),
      agent: agentProfile,
      project: task.project_id ? {
        id: task.project_id,
        name: task.project_name
      } : null,
      sprint: task.sprint_id ? {
        id: task.sprint_id,
        name: task.sprint_name
      } : null,
      knowledge,
      deliverables,
      relatedTasks
    });
  } catch (err) {
    console.error('Error getting task context:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/tasks/:id
 * Update task
 */
router.patch('/:id', userAuth, validateBody(updateTaskSchema), async (req, res) => {
  try {
    const task = await db.one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) {
      return response.notFound(res, 'Task');
    }

    const {
      title, description, projectId, sprintId, assignedAgentId,
      status, priority, context, dueDate, tags
    } = req.body;

    const updates = [];
    const values = [];
    let shouldTriggerAssignedWebhook = false;
    let shouldTriggerUpdatedWebhook = false;

    if (tags !== undefined) {
      updates.push('tags = ?');
      values.push(JSON.stringify(tags));
    }
    if (title !== undefined) {
      updates.push('title = ?');
      values.push(title);
      shouldTriggerUpdatedWebhook = true;
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
      shouldTriggerUpdatedWebhook = true;
    }
    if (projectId !== undefined) {
      updates.push('project_id = ?');
      values.push(projectId);
    }
    if (sprintId !== undefined) {
      if (sprintId !== null) {
        const sprint = await db.one('SELECT id FROM sprints WHERE id = ?', [sprintId]);
        if (!sprint) {
          return response.validationError(res, 'Invalid sprint ID');
        }
      }
      updates.push('sprint_id = ?');
      values.push(sprintId);
    }
    // Track routing metadata for auto-assign attempts
    let patchRoutingDecision = null;
    let patchFinalAgentId = null;
    let patchAutoAssignAttempted = false;

    // Track whether we need deferred count changes (done inside transaction with UPDATE)
    let deferredCountChanges = null; // { type: 'reassign'|'unassign'|'auto_assign', ... }
    let assignedAgentValueIdx = -1; // positional index of assigned_agent_id in values[]

    if (assignedAgentId !== undefined) {
      const isPatchAutoAssign = assignedAgentId === 'auto';
      let resolvedAgentId = isPatchAutoAssign ? null : assignedAgentId;

      // Auto-assign: evaluate routing rules when 'auto' and task has a project (read-only)
      if (isPatchAutoAssign) {
        const effectiveProjectId = projectId !== undefined ? projectId : task.project_id;
        if (effectiveProjectId) {
          patchAutoAssignAttempted = true;
          const routingTaskData = {
            title: title || task.title,
            description: description || task.description,
            priority: priority || task.priority,
            tags: tags !== undefined ? tags : safeJsonParse(task.tags, [])
          };
          const routingResult = await evaluateRoutingRules(effectiveProjectId, routingTaskData);
          patchRoutingDecision = routingResult.decision;
          if (routingResult.matched && routingResult.agentId) {
            resolvedAgentId = routingResult.agentId;
            if (routingResult.ruleId) {
              updates.push('routing_rule_id = ?');
              values.push(routingResult.ruleId);
            }
            updates.push('routing_decision = ?');
            values.push(routingResult.decision);
          } else {
            updates.push('routing_decision = ?');
            values.push(routingResult.decision);
          }
          patchFinalAgentId = resolvedAgentId || null;
        }
      }

      // Check if this is a new assignment or reassignment
      if (resolvedAgentId && resolvedAgentId !== task.assigned_agent_id) {
        const agent = await db.one('SELECT id FROM agents WHERE id = ?', [resolvedAgentId]);
        if (!agent) {
          return response.validationError(res, 'Invalid agent ID');
        }
        shouldTriggerAssignedWebhook = true;

        // Defer count changes to happen in transaction with UPDATE (Issue #18)
        if (isPatchAutoAssign) {
          deferredCountChanges = { type: 'auto_assign', newAgentId: resolvedAgentId, oldAgentId: task.assigned_agent_id };
        } else {
          // Direct assignment bypasses capacity check (admin override)
          deferredCountChanges = { type: 'reassign', newAgentId: resolvedAgentId, oldAgentId: task.assigned_agent_id };
        }
      } else if (!resolvedAgentId && task.assigned_agent_id) {
        // Unassigning from agent
        deferredCountChanges = { type: 'unassign', oldAgentId: task.assigned_agent_id };
      }
      updates.push('assigned_agent_id = ?');
      assignedAgentValueIdx = values.length; // track position before push
      values.push(resolvedAgentId);
      if (resolvedAgentId && !task.assigned_at) {
        updates.push("assigned_at = datetime('now')");
      }
    }
    if (status !== undefined) {
      const validStatuses = ['pending', 'assigned', 'in_progress', 'review', 'completed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return response.validationError(res, `Status must be one of: ${validStatuses.join(', ')}`);
      }
      updates.push('status = ?');
      values.push(status);

      if (status === 'in_progress' && task.status !== 'in_progress') {
        updates.push("started_at = datetime('now')");
      }
      if (status === 'completed' && task.status !== 'completed') {
        updates.push("completed_at = datetime('now')");
      }
      shouldTriggerUpdatedWebhook = true;
    }
    if (priority !== undefined) {
      updates.push('priority = ?');
      values.push(priority);
      shouldTriggerUpdatedWebhook = true;
    }
    if (context !== undefined) {
      updates.push('context = ?');
      values.push(JSON.stringify(context));
    }
    if (dueDate !== undefined) {
      updates.push('due_date = ?');
      values.push(dueDate);
      shouldTriggerUpdatedWebhook = true;
    }

    if (updates.length === 0) {
      return response.validationError(res, 'No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    // Wrap UPDATE + count changes in transaction so counts don't drift (Issue #18)
    await db.tx(async (tx) => {
      // Handle deferred assignment count changes
      if (deferredCountChanges) {
        if (deferredCountChanges.type === 'auto_assign') {
          // Auto-assign: enforce capacity via reservation
          const reservation = await reserveAgentCapacity(deferredCountChanges.newAgentId, tx);
          if (!reservation.ok) {
            // Capacity race — clear assignment, update routing decision
            // Use tracked index (not indexOf) to avoid corrupting unrelated params
            values[assignedAgentValueIdx] = null;
            patchFinalAgentId = null;
            patchRoutingDecision = reservation.reason;
            const rdIdx = updates.findIndex(u => u === 'routing_decision = ?');
            if (rdIdx !== -1) {
              values[rdIdx] = reservation.reason;
            }
            shouldTriggerAssignedWebhook = false;
          }
          // Always release old agent — task is moving away regardless of
          // whether the new reservation succeeded or fell back to unassigned
          if (deferredCountChanges.oldAgentId) {
            await decrementActiveTaskCount(deferredCountChanges.oldAgentId, tx);
          }
        } else if (deferredCountChanges.type === 'reassign') {
          // Direct assignment bypasses capacity check (admin override)
          await incrementActiveTaskCount(deferredCountChanges.newAgentId, tx);
          if (deferredCountChanges.oldAgentId) {
            await decrementActiveTaskCount(deferredCountChanges.oldAgentId, tx);
          }
        } else if (deferredCountChanges.type === 'unassign') {
          await decrementActiveTaskCount(deferredCountChanges.oldAgentId, tx);
        }
      }

      await tx.exec(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);

      // Handle active_task_count changes based on status transitions
      const terminalStatuses = ['completed', 'cancelled'];
      const activeStatuses = ['in_progress'];
      const oldWasTerminal = terminalStatuses.includes(task.status);
      const newIsTerminal = terminalStatuses.includes(status);
      const newIsActive = activeStatuses.includes(status);

      // Need to read the updated task for agent ID
      const updatedForCount = await tx.one('SELECT assigned_agent_id FROM tasks WHERE id = ?', [req.params.id]);

      // If task moved FROM terminal TO active status, increment active count
      if (oldWasTerminal && newIsActive && updatedForCount.assigned_agent_id) {
        await incrementActiveTaskCount(updatedForCount.assigned_agent_id, tx);
      }
      // If task moved FROM active TO terminal status, decrement active count
      else if (!oldWasTerminal && newIsTerminal && updatedForCount.assigned_agent_id) {
        await decrementActiveTaskCount(updatedForCount.assigned_agent_id, tx);
      }
    });

    const updated = await db.one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    const parsedTask = normalizeTaskTimestamps(updated);

    // Trigger webhooks
    if (shouldTriggerAssignedWebhook && updated.assigned_agent_id) {
      triggerWebhook(updated.assigned_agent_id, 'task.assigned', { task: parsedTask });

      // Dispatch task.assigned to delivery routes (e.g., notify human agents)
      if (updated.project_id) {
        const projectForAssign = await db.one('SELECT id, name FROM projects WHERE id = ?', [updated.project_id]);
        const assignee = await buildAssigneeInfo(updated.assigned_agent_id);
        dispatchEvent('task.assigned', {
          project: projectForAssign ? { id: projectForAssign.id, name: projectForAssign.name } : { id: updated.project_id },
          projectId: updated.project_id,
          task: parsedTask,
          agent: assignee,
          assignee,
          timestamp: new Date().toISOString()
        }).catch(err => console.error('[Tasks] Route dispatch error:', err));
      }
    } else if (shouldTriggerUpdatedWebhook && updated.assigned_agent_id) {
      triggerWebhook(updated.assigned_agent_id, 'task.updated', { task: parsedTask });
    }

    // Dispatch task.status_changed event to delivery routes (if status changed and project-scoped)
    if (status !== undefined && status !== task.status && updated.project_id) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [updated.project_id]);
      const statusAssignee = updated.assigned_agent_id ? await buildAssigneeInfo(updated.assigned_agent_id) : null;
      dispatchEvent('task.status_changed', {
        project: project ? { id: project.id, name: project.name } : { id: updated.project_id },
        projectId: updated.project_id,
        task: {
          id: updated.id,
          title: updated.title,
          description: updated.description,
          status: updated.status,
          priority: updated.priority,
          tags: safeJsonParse(updated.tags, []),
          assigned_agent_id: updated.assigned_agent_id,
          due_date: updated.due_date
        },
        agent: statusAssignee,
        assignee: statusAssignee,
        old_status: task.status,
        new_status: status,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Tasks] Route dispatch error:', err));

      if (status === 'completed') {
        dispatchEvent('task.completed', {
          project: project ? { id: project.id, name: project.name } : { id: updated.project_id },
          projectId: updated.project_id,
          task: {
            id: updated.id, title: updated.title, description: updated.description,
            status: updated.status, priority: updated.priority,
            tags: safeJsonParse(updated.tags, []),
            assigned_agent_id: updated.assigned_agent_id, due_date: updated.due_date
          },
          agent: statusAssignee, assignee: statusAssignee,
          timestamp: new Date().toISOString()
        }).catch(err => console.error('[Tasks] Route dispatch error:', err));
      }
    }

    // Attach routing metadata when auto-assign was attempted
    if (patchAutoAssignAttempted) {
      const isUnconfigured = !patchRoutingDecision ||
        patchRoutingDecision === 'No matching rule and no default agent configured';
      const needsConfiguration = !patchFinalAgentId && isUnconfigured;
      parsedTask.routing = {
        attempted: true,
        matched: !!patchFinalAgentId,
        assignedAgentId: patchFinalAgentId,
        decision: patchRoutingDecision,
        needsConfiguration
      };
    }

    response.success(res, parsedTask);
  } catch (err) {
    console.error('Error updating task:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/tasks/:id
 * Delete task
 */
router.delete('/:id', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const task = await db.one('SELECT id, title, description, assigned_agent_id, status, priority, project_id, tags FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) {
      return response.notFound(res, 'Task');
    }

    await db.exec('DELETE FROM tasks WHERE id = ?', [req.params.id]);

    // Decrement agent active_task_count if task was actively counting against capacity
    if (task.assigned_agent_id && task.status === 'in_progress') {
      await db.exec(`
        UPDATE agents
        SET active_task_count = MAX(0, COALESCE(active_task_count, 0) - 1),
            updated_at = datetime('now')
        WHERE id = ?
      `, [task.assigned_agent_id]);
    }

    // Dispatch task.status_changed event (deleted -> treated as cancelled)
    if (task.project_id) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [task.project_id]);
      const delAssignee = task.assigned_agent_id ? await buildAssigneeInfo(task.assigned_agent_id) : null;
      dispatchEvent('task.status_changed', {
        project: project ? { id: project.id, name: project.name } : { id: task.project_id },
        projectId: task.project_id,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          status: 'deleted',
          priority: task.priority,
          tags: safeJsonParse(task.tags, []),
          assigned_agent_id: task.assigned_agent_id
        },
        agent: delAssignee,
        assignee: delAssignee,
        old_status: task.status,
        new_status: 'deleted',
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Tasks] Route dispatch error:', err));
    }

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting task:', err);
    response.serverError(res);
  }
});

// ============================================
// Agent endpoints (require agent authentication)
// ============================================

/**
 * PATCH /api/tasks/:id/status
 * Update task status (agent endpoint)
 */
router.patch('/:id/status', agentAuth, validateBody(updateTaskStatusSchema), logAgentActivity('task.status_updated', (req, data) => ({
  type: 'task',
  id: parseInt(req.params.id),
  details: { status: req.body.status }
})), async (req, res) => {
  try {
    const task = await db.one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) {
      return response.notFound(res, 'Task');
    }

    // Verify task is assigned to this agent (or to an agent owned by this user)
    if (req.agent.isUserKey) {
      const ownedIds = req.agent.ownedAgentIds || [];
      if (!ownedIds.includes(task.assigned_agent_id)) {
        return response.forbidden(res, 'Task not assigned to an agent you own');
      }
    } else if (task.assigned_agent_id !== req.agent.id) {
      return response.forbidden(res, 'Task not assigned to this agent');
    }

    const { status, progress } = req.body;

    const validStatuses = ['in_progress', 'review'];
    if (!validStatuses.includes(status)) {
      return response.validationError(res, `Status must be one of: ${validStatuses.join(', ')}`);
    }

    const updates = ['status = ?', "updated_at = datetime('now')"];
    const values = [status];

    if (status === 'in_progress' && task.status !== 'in_progress') {
      updates.push("started_at = datetime('now')");
    }

    if (progress !== undefined) {
      // Store progress in context
      const context = safeJsonParse(task.context, {});
      context.progress = progress;
      updates.push('context = ?');
      values.push(JSON.stringify(context));
    }

    values.push(req.params.id);

    await db.exec(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);

    // Log activity
    if (status !== task.status) {
      const agentName = req.agent.id
        ? ((await db.one('SELECT name FROM agents WHERE id = ?', [req.agent.id]))?.name || 'agent')
        : 'agent';
      logActivity('task', parseInt(req.params.id), 'status_changed', agentName, { from: task.status, to: status });
    }

    const updated = await db.one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);

    // Dispatch task.status_changed event to delivery routes (if project-scoped)
    if (status !== task.status && updated.project_id) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [updated.project_id]);
      const scAssignee = updated.assigned_agent_id ? await buildAssigneeInfo(updated.assigned_agent_id) : null;
      dispatchEvent('task.status_changed', {
        project: project ? { id: project.id, name: project.name } : { id: updated.project_id },
        projectId: updated.project_id,
        task: {
          id: updated.id,
          title: updated.title,
          description: updated.description,
          status: updated.status,
          priority: updated.priority,
          tags: safeJsonParse(updated.tags, []),
          assigned_agent_id: updated.assigned_agent_id,
          due_date: updated.due_date
        },
        agent: scAssignee,
        assignee: scAssignee,
        old_status: task.status,
        new_status: status,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Tasks] Route dispatch error:', err));

      if (status === 'completed') {
        dispatchEvent('task.completed', {
          project: project ? { id: project.id, name: project.name } : { id: updated.project_id },
          projectId: updated.project_id,
          task: {
            id: updated.id, title: updated.title, description: updated.description,
            status: updated.status, priority: updated.priority,
            tags: safeJsonParse(updated.tags, []),
            assigned_agent_id: updated.assigned_agent_id, due_date: updated.due_date
          },
          agent: scAssignee, assignee: scAssignee,
          timestamp: new Date().toISOString()
        }).catch(err => console.error('[Tasks] Route dispatch error:', err));
      }
    }

    response.success(res, normalizeTaskTimestamps(updated));
  } catch (err) {
    console.error('Error updating task status:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/tasks/:id/progress
 * Log a progress update for a task (agent endpoint)
 */
router.post('/:id/progress', agentAuth, validateBody(logTaskProgressSchema), logAgentActivity('task.progress_logged', (req, data) => ({
  type: 'task',
  id: parseInt(req.params.id),
  details: { message: req.body.message, percentComplete: req.body.percentComplete }
})), async (req, res) => {
  try {
    const task = await db.one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) {
      return response.notFound(res, 'Task');
    }

    // Verify task is assigned to this agent (or to an agent owned by this user)
    let effectiveAgentId = req.agent.id;
    if (req.agent.isUserKey) {
      const ownedIds = req.agent.ownedAgentIds || [];
      if (!ownedIds.includes(task.assigned_agent_id)) {
        return response.forbidden(res, 'Task not assigned to an agent you own');
      }
      effectiveAgentId = task.assigned_agent_id;
    } else if (task.assigned_agent_id !== req.agent.id) {
      return response.forbidden(res, 'Task not assigned to this agent');
    }

    const { message, percentComplete, details } = req.body;

    // Insert progress record
    const result = await db.insert(`
      INSERT INTO task_progress (task_id, agent_id, message, percent_complete, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      req.params.id,
      effectiveAgentId,
      message,
      percentComplete ?? null,
      JSON.stringify(details || {})
    ]);

    const progress = await db.one('SELECT * FROM task_progress WHERE id = ?', [result.lastInsertRowid]);

    // Update task context with latest progress if percentComplete is provided
    if (percentComplete !== undefined && percentComplete !== null) {
      const context = safeJsonParse(task.context, {});
      context.lastProgress = {
        percentComplete,
        message,
        timestamp: new Date().toISOString()
      };
      await db.exec(`
        UPDATE tasks SET context = ?, updated_at = datetime('now') WHERE id = ?
      `, [JSON.stringify(context), req.params.id]);
    }

    // Trigger webhook with the effective agent (not null for user keys)
    triggerWebhook(effectiveAgentId, 'task.progress_updated', {
      task: normalizeTaskTimestamps(task),
      progress: {
        id: progress.id,
        message,
        percentComplete: percentComplete ?? null,
        details: details || {},
        createdAt: toISOTimestamp(progress.created_at)
      }
    });

    response.created(res, {
      id: progress.id,
      taskId: parseInt(req.params.id),
      agentId: effectiveAgentId,
      message,
      percentComplete: percentComplete ?? null,
      details: details || {},
      createdAt: toISOTimestamp(progress.created_at)
    });
  } catch (err) {
    console.error('Error logging task progress:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/tasks/:id/claim
 * Claim a task for the requesting agent (agent endpoint)
 * Uses atomic conditional update to prevent race conditions
 */
router.post('/:id/claim', agentAuth, logAgentActivity('task.claimed', (req, data) => ({
  type: 'task',
  id: parseInt(req.params.id),
  details: {}
})), async (req, res) => {
  try {
    // Use a transaction with conditional update to prevent race conditions
    const result = await db.tx(async (tx) => {
      const task = await tx.one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
      if (!task) {
        return { error: 'not_found' };
      }

      // Verify task is in a claimable status
      const claimableStatuses = ['pending', 'assigned'];
      if (!claimableStatuses.includes(task.status)) {
        return { error: 'invalid_status', status: task.status };
      }

      // Resolve effective agent ID for claiming
      // For user keys, pick the first owned agent (human agent linked to this user)
      let claimAgentId = req.agent.id;
      if (req.agent.isUserKey) {
        const ownedIds = req.agent.ownedAgentIds || [];
        if (ownedIds.length === 0) {
          return { error: 'no_linked_agent' };
        }
        claimAgentId = ownedIds[0]; // Use the user's primary linked agent
      }

      // Verify task is not already assigned to another agent
      if (task.assigned_agent_id && task.assigned_agent_id !== claimAgentId) {
        const assignedAgent = await tx.one('SELECT name FROM agents WHERE id = ?', [task.assigned_agent_id]);
        return { error: 'already_assigned', agentName: assignedAgent?.name || task.assigned_agent_id };
      }

      // If already assigned to this agent, just return the task
      if (task.assigned_agent_id === claimAgentId) {
        return { task, alreadyClaimed: true };
      }

      // Atomic conditional update - only update if status and assignment haven't changed
      const newStatus = task.status === 'pending' ? 'assigned' : task.status;
      const updateResult = await tx.exec(`
        UPDATE tasks
        SET assigned_agent_id = ?, status = ?, assigned_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
          AND status IN ('pending', 'assigned')
          AND (assigned_agent_id IS NULL OR assigned_agent_id = ?)
      `, [claimAgentId, newStatus, req.params.id, claimAgentId]);

      // Check if update was successful (row was actually modified)
      if (updateResult.changes === 0) {
        // Task was claimed by another agent between our read and write
        return { error: 'race_condition' };
      }

      const updated = await tx.one('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
      return { task: updated, claimed: true };
    });

    // Handle errors
    if (result.error === 'not_found') {
      return response.notFound(res, 'Task');
    }
    if (result.error === 'invalid_status') {
      return response.validationError(res, `Task cannot be claimed: status is '${result.status}'. Only tasks with status 'pending' or 'assigned' can be claimed.`);
    }
    if (result.error === 'no_linked_agent') {
      return response.forbidden(res, 'No linked agent found for this user key. Create a user account with a linked agent first.');
    }
    if (result.error === 'already_assigned') {
      return response.forbidden(res, `Task is already assigned to agent '${result.agentName}'`);
    }
    if (result.error === 'race_condition') {
      return response.conflict(res, 'Task was claimed by another agent. Please try a different task.');
    }

    const parsedTask = normalizeTaskTimestamps(result.task);

    // Increment agent's active task count if we actually claimed it
    if (result.claimed) {
      await incrementActiveTaskCount(req.agent.id);
      const claimAgentName = (await db.one('SELECT name FROM agents WHERE id = ?', [req.agent.id]))?.name || 'agent';
      logActivity('task', parseInt(req.params.id), 'assigned', claimAgentName, { assigned_to: claimAgentName });
      triggerWebhook(req.agent.id, 'task.claimed', { task: parsedTask });

      // Dispatch task.assigned event for delivery routes
      if (parsedTask.projectId || parsedTask.project_id) {
        const projectId = parsedTask.projectId || parsedTask.project_id;
        const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [projectId]);
        const assignee = await buildAssigneeInfo(req.agent.id);
        dispatchEvent('task.assigned', {
          project: project ? { id: project.id, name: project.name } : { id: projectId },
          projectId,
          task: {
            id: parsedTask.id,
            title: parsedTask.title,
            description: parsedTask.description,
            status: parsedTask.status,
            priority: parsedTask.priority,
            assigned_agent_id: parsedTask.assignedAgentId || parsedTask.assigned_agent_id,
            assigned_agent_name: claimAgentName
          },
          agent: assignee,
          assignee,
          assigned_by: 'self_claim',
          timestamp: new Date().toISOString()
        }).catch(err => console.error('[Tasks] Route dispatch error:', err));
      }
    }

    response.success(res, parsedTask);
  } catch (err) {
    console.error('Error claiming task:', err);
    response.serverError(res);
  }
});

// ============================================
// Activity log endpoint
// ============================================

/**
 * GET /api/tasks/:id/activity
 * Get activity log for a task
 */
router.get('/:id/activity', dualAuth, async (req, res) => {
  try {
    // Authorization check
    const access = canAccessTask(req, req.params.id);
    if (!access.allowed) {
      return access.reason === 'not_found'
        ? response.notFound(res, 'Task')
        : response.forbidden(res, 'Access denied');
    }

    const task = await db.one('SELECT id FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) {
      return response.notFound(res, 'Task');
    }

    const activities = await db.many(`
      SELECT id, event_type, actor_name, detail, created_at
      FROM activity_log
      WHERE entity_type = 'task' AND entity_id = ?
      ORDER BY created_at DESC
    `, [req.params.id]);

    const parsed = activities.map(a => ({
      ...a,
      detail: safeJsonParse(a.detail, {}),
      created_at: toISOTimestamp(a.created_at)
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error fetching task activity:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/tasks/:id/execute
 * Manually trigger execution for a task (admin only)
 */
router.post('/:id/execute', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const { executeTaskNow } = await import('../services/taskDispatcher.js');
    const result = await executeTaskNow(parseInt(req.params.id));
    response.success(res, result);
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('not assigned')) {
      return response.notFound(res, err.message);
    }
    if (err.message.includes('not have task execution')) {
      return response.badRequest(res, err.message);
    }
    console.error('Error executing task:', err);
    response.serverError(res, err.message);
  }
});

/**
 * POST /tasks/:id/retry
 * Clear execution error from a task so the dispatcher will pick it up again.
 * Also allows resetting status to 'assigned' if currently stuck.
 */
router.post('/:id/retry', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const task = await db.one('SELECT id, context, status, assigned_agent_id FROM tasks WHERE id = ?', [req.params.id]);
    if (!task) return response.notFound(res, 'Task');
    if (!task.assigned_agent_id) return response.badRequest(res, 'Task is not assigned to an agent');

    let context = {};
    try { context = JSON.parse(task.context || '{}'); } catch { context = {}; }

    const hadError = !!context.lastExecutionError;
    delete context.lastExecutionError;

    // Reset to 'assigned' if stuck in a failed state
    const newStatus = ['pending', 'assigned'].includes(task.status) ? task.status : 'assigned';

    await db.exec(`
      UPDATE tasks SET context = ?, status = ?, updated_at = datetime('now') WHERE id = ?
    `, [JSON.stringify(context), newStatus, task.id]);

    logActivity('task', task.id, 'retry_requested', req.user?.name || 'admin', {
      previousStatus: task.status,
      newStatus,
      errorCleared: hadError
    });

    response.success(res, { retried: true, status: newStatus, errorCleared: hadError });
  } catch (err) {
    console.error('Error retrying task:', err);
    response.serverError(res);
  }
});

export default router;
