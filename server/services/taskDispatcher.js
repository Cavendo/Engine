/**
 * Task Dispatcher Service
 *
 * Background service that automatically executes tasks assigned to agents
 * with execution_mode = 'auto'. Runs on a configurable interval, respects
 * agent capacity limits, and logs all activity for user visibility.
 *
 * Lifecycle:
 *   1. Poll for eligible tasks (assigned to auto-exec agents, status pending/assigned)
 *   2. Check agent capacity (active_task_count < max_concurrent_tasks)
 *   3. Execute task via agentExecutor
 *   4. Log success/failure to agent_activity and activity_log
 *   5. On failure, flag the task and log error details
 */

import db from '../db/connection.js';
import { executeTask } from './agentExecutor.js';
import { dispatchEvent } from './routeDispatcher.js';
import { evaluateRoutingRules, incrementActiveTaskCount as routerIncrementCount } from './taskRouter.js';

const POLL_INTERVAL_MS = parseInt(process.env.DISPATCHER_INTERVAL_MS) || 30000; // 30 seconds
const MAX_BATCH_SIZE = parseInt(process.env.DISPATCHER_BATCH_SIZE) || 5; // max tasks per cycle

let intervalHandle = null;
let isRunning = false;

/**
 * Log to agent_activity table
 */
function logAgentActivity(agentId, action, resourceType, resourceId, details) {
  try {
    db.prepare(`
      INSERT INTO agent_activity (agent_id, action, resource_type, resource_id, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(agentId, action, resourceType, resourceId, JSON.stringify(details));
  } catch (err) {
    console.error('[Dispatcher] Failed to log agent activity:', err);
  }
}

/**
 * Log to universal activity_log table
 */
function logActivity(entityType, entityId, eventType, actorName, detail) {
  try {
    db.prepare(`
      INSERT INTO activity_log (entity_type, entity_id, event_type, actor_name, detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(entityType, entityId, eventType, actorName, JSON.stringify(detail));
  } catch (err) {
    console.error('[Dispatcher] Failed to log activity:', err);
  }
}

/**
 * Find tasks eligible for automatic execution
 */
function findEligibleTasks() {
  return db.prepare(`
    SELECT
      t.id as task_id,
      t.title as task_title,
      t.status as task_status,
      t.priority,
      t.project_id,
      a.id as agent_id,
      a.name as agent_name,
      a.provider,
      a.provider_api_key_encrypted,
      a.active_task_count,
      a.max_concurrent_tasks
    FROM tasks t
    JOIN agents a ON a.id = t.assigned_agent_id
    WHERE t.status IN ('pending', 'assigned')
      AND a.execution_mode = 'auto'
      AND a.status = 'active'
      AND a.provider IS NOT NULL
      AND a.provider_api_key_encrypted IS NOT NULL
      AND (a.max_concurrent_tasks IS NULL OR a.active_task_count < a.max_concurrent_tasks)
      -- due_date is a deadline, not a start schedule; do not gate auto-dispatch on it
    ORDER BY t.priority ASC, t.created_at ASC
    LIMIT ?
  `).all(MAX_BATCH_SIZE);
}

/**
 * Execute a single task and handle all logging
 */
async function dispatchTask(eligible) {
  const { task_id, task_title, agent_id, agent_name } = eligible;

  console.log(`[Dispatcher] Executing task #${task_id} "${task_title}" via agent "${agent_name}"`);

  // Increment active_task_count while executing
  incrementActiveTaskCount(agent_id);

  // Log execution start
  logAgentActivity(agent_id, 'task.execution_started', 'task', task_id, {
    title: task_title,
    trigger: 'auto_dispatch'
  });
  logActivity('task', task_id, 'execution_started', 'system', {
    agentId: agent_id,
    agentName: agent_name,
    trigger: 'auto_dispatch'
  });

  // Load full agent and task records for the executor
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent_id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id);

  if (!agent || !task) {
    console.error(`[Dispatcher] Agent or task not found (agent: ${agent_id}, task: ${task_id})`);
    decrementActiveTaskCount(agent_id);
    return;
  }

  try {
    const result = await executeTask(agent, task);

    // Decrement active_task_count — task is no longer being actively executed
    decrementActiveTaskCount(agent_id);

    if (result.success) {
      console.log(`[Dispatcher] Task #${task_id} completed successfully — deliverable #${result.deliverableId}`);

      // Log success
      logAgentActivity(agent_id, 'task.execution_completed', 'task', task_id, {
        title: task_title,
        deliverableId: result.deliverableId,
        usage: result.usage
      });
      logActivity('task', task_id, 'execution_completed', 'system', {
        agentId: agent_id,
        agentName: agent_name,
        deliverableId: result.deliverableId,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens
      });
      logActivity('deliverable', result.deliverableId, 'created', agent_name, {
        taskId: task_id,
        taskTitle: task_title,
        trigger: 'auto_dispatch'
      });
    } else {
      console.error(`[Dispatcher] Task #${task_id} execution failed: ${result.error}`);

      // Log failure
      logAgentActivity(agent_id, 'task.execution_failed', 'task', task_id, {
        title: task_title,
        error: result.error
      });
      logActivity('task', task_id, 'execution_failed', 'system', {
        agentId: agent_id,
        agentName: agent_name,
        error: result.error
      });

      // Flag the task so the user can see the error
      flagTaskError(task_id, agent_name, result.error, result.category);

      // Dispatch task.execution_failed event to delivery routes
      if (eligible.project_id) {
        const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(eligible.project_id);
        dispatchEvent('task.execution_failed', {
          project: project ? { id: project.id, name: project.name } : { id: eligible.project_id },
          projectId: eligible.project_id,
          task: { id: task_id, title: task_title },
          error: result.error,
          errorCategory: result.category || classifyErrorMessage(result.error),
          agentName: agent_name,
          timestamp: new Date().toISOString()
        }).catch(err => console.error('[Dispatcher] Route dispatch error:', err));
      }
    }
  } catch (err) {
    console.error(`[Dispatcher] Unexpected error executing task #${task_id}:`, err);

    // Decrement active_task_count on failure too
    decrementActiveTaskCount(agent_id);

    logAgentActivity(agent_id, 'task.execution_failed', 'task', task_id, {
      title: task_title,
      error: err.message
    });
    logActivity('task', task_id, 'execution_failed', 'system', {
      agentId: agent_id,
      agentName: agent_name,
      error: err.message
    });

    flagTaskError(task_id, agent_name, err.message, err.category);

    // Dispatch task.execution_failed event to delivery routes
    if (eligible.project_id) {
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(eligible.project_id);
      dispatchEvent('task.execution_failed', {
        project: project ? { id: project.id, name: project.name } : { id: eligible.project_id },
        projectId: eligible.project_id,
        task: { id: task_id, title: task_title },
        error: err.message,
        errorCategory: err.category || classifyErrorMessage(err.message),
        agentName: agent_name,
        timestamp: new Date().toISOString()
      }).catch(dispatchErr => console.error('[Dispatcher] Route dispatch error:', dispatchErr));
    }
  }
}

/**
 * Increment agent active_task_count when starting execution
 */
function incrementActiveTaskCount(agentId) {
  try {
    db.prepare(`
      UPDATE agents
      SET active_task_count = COALESCE(active_task_count, 0) + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(agentId);
  } catch (err) {
    console.error('[Dispatcher] Failed to increment active_task_count:', err);
  }
}

/**
 * Decrement agent active_task_count when execution finishes (success or failure)
 */
function decrementActiveTaskCount(agentId) {
  try {
    db.prepare(`
      UPDATE agents
      SET active_task_count = MAX(0, COALESCE(active_task_count, 0) - 1),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(agentId);
  } catch (err) {
    console.error('[Dispatcher] Failed to decrement active_task_count:', err);
  }
}

/**
 * Flag a task with an error so the user can see it in the UI.
 * Stores the error in the task's context JSON and resets status to 'assigned'
 * so the dispatcher doesn't retry it in a loop.
 */
function flagTaskError(taskId, agentName, errorMessage, errorCategory) {
  // Step 1: Always reset status — must not be silenced by context-building failures
  try {
    db.prepare(`
      UPDATE tasks SET status = 'assigned', updated_at = datetime('now') WHERE id = ?
    `).run(taskId);
  } catch (err) {
    console.error(`[Dispatcher] CRITICAL: Failed to reset task #${taskId} status from in_progress:`, err);
  }

  // Step 2: Store error details in context — secondary, safe to fail independently
  try {
    const task = db.prepare('SELECT context FROM tasks WHERE id = ?').get(taskId);
    let context = {};
    try { context = JSON.parse(task?.context || '{}'); } catch { context = {}; }

    context.lastExecutionError = {
      error: errorMessage,
      category: errorCategory || classifyErrorMessage(errorMessage),
      agent: agentName,
      timestamp: new Date().toISOString(),
      retryable: isRetryableError(errorMessage, errorCategory)
    };

    db.prepare(`
      UPDATE tasks SET context = ?, updated_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(context), taskId);
  } catch (err) {
    console.error(`[Dispatcher] Failed to store error context for task #${taskId}:`, err);
  }
}

/**
 * Classify an error message string into a category (fallback when category not available)
 */
function classifyErrorMessage(msg) {
  if (!msg) return 'unknown';
  const lower = msg.toLowerCase();
  if (lower.includes('invalid_api_key') || lower.includes('authentication') || lower.includes('401')) return 'auth_error';
  if (lower.includes('insufficient_quota') || lower.includes('billing') || lower.includes('quota')) return 'quota_exceeded';
  if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limited';
  if (lower.includes('timeout') || lower.includes('aborted')) return 'timeout';
  if (lower.includes('overloaded') || lower.includes('529') || lower.includes('503')) return 'overloaded';
  if (lower.includes('decrypt') || lower.includes('encryption_key') || lower.includes('config')) return 'config_error';
  return 'unknown';
}

/**
 * Check if an error is likely retryable (rate limits, timeouts, config errors)
 */
function isRetryableError(errorMessage, category) {
  if (category) return ['rate_limited', 'overloaded', 'timeout', 'config_error'].includes(category);
  if (!errorMessage) return false;
  const msg = errorMessage.toLowerCase();
  return msg.includes('rate limit') || msg.includes('timeout') || msg.includes('aborted') ||
         msg.includes('overloaded') || msg.includes('529') || msg.includes('503') ||
         msg.includes('decrypt');
}

/**
 * Reconcile active_task_count with actual in-progress tasks.
 * Fixes drift caused by server crashes or unclean shutdowns.
 */
function reconcileTaskCounts() {
  try {
    // Fix agents with NULL max_concurrent_tasks (created before default was enforced)
    const nullCapacity = db.prepare(`
      UPDATE agents SET max_concurrent_tasks = 5 WHERE max_concurrent_tasks IS NULL
    `).run();
    if (nullCapacity.changes > 0) {
      console.log(`[Dispatcher] Fixed ${nullCapacity.changes} agent(s) with NULL max_concurrent_tasks → 5`);
    }

    const drifted = db.prepare(`
      SELECT a.id, a.name, a.active_task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.assigned_agent_id = a.id AND t.status = 'in_progress') as actual_count
      FROM agents a
      WHERE a.active_task_count != (
        SELECT COUNT(*) FROM tasks t WHERE t.assigned_agent_id = a.id AND t.status = 'in_progress'
      )
    `).all();

    for (const agent of drifted) {
      console.log(`[Dispatcher] Reconciling active_task_count for "${agent.name}": ${agent.active_task_count} → ${agent.actual_count}`);
      db.prepare('UPDATE agents SET active_task_count = ? WHERE id = ?').run(agent.actual_count, agent.id);
    }
  } catch (err) {
    console.error('[Dispatcher] Failed to reconcile task counts:', err);
  }
}

/**
 * Safely parse JSON with a fallback value
 */
function safeJsonParse(str, defaultValue = null) {
  if (!str) return defaultValue;
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

/**
 * Route unassigned tasks that have a project but no agent.
 * Re-attempts routing rules each cycle so tasks get assigned
 * once agent capacity frees up.
 */
function routeUnassignedTasks() {
  try {
    const unassigned = db.prepare(`
      SELECT id, title, project_id, tags, priority, context,
             required_capabilities, preferred_agent_id
      FROM tasks
      WHERE status = 'pending'
        AND assigned_agent_id IS NULL
        AND project_id IS NOT NULL
      ORDER BY priority ASC, created_at ASC
      LIMIT ?
    `).all(MAX_BATCH_SIZE);

    if (unassigned.length === 0) return;

    for (const task of unassigned) {
      const taskData = {
        tags: safeJsonParse(task.tags, []),
        priority: task.priority || 2,
        context: safeJsonParse(task.context, {}),
        requiredCapabilities: safeJsonParse(task.required_capabilities, []),
        preferredAgentId: task.preferred_agent_id
      };

      const routingResult = evaluateRoutingRules(task.project_id, taskData);
      if (routingResult.matched && routingResult.agentId) {
        const updateResult = db.prepare(`
          UPDATE tasks SET assigned_agent_id = ?, status = 'assigned',
            assigned_at = datetime('now'), updated_at = datetime('now'),
            routing_rule_id = ?, routing_decision = ?
          WHERE id = ? AND assigned_agent_id IS NULL
        `).run(routingResult.agentId, routingResult.ruleId || null, routingResult.decision, task.id);

        // Only increment if the row was actually updated (guards against concurrent assignment)
        if (updateResult.changes > 0) {
          routerIncrementCount(routingResult.agentId);
          console.log(`[Dispatcher] Routed task #${task.id} "${task.title}" → agent ${routingResult.agentId}`);

          // Dispatch task.assigned to delivery routes (e.g., notify human agents via email)
          const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(task.project_id);
          const assignedAgent = db.prepare('SELECT id, name, execution_mode, owner_user_id FROM agents WHERE id = ?').get(routingResult.agentId);
          const assignee = assignedAgent ? { id: assignedAgent.id, name: assignedAgent.name, executionMode: assignedAgent.execution_mode } : { id: routingResult.agentId };
          // Enrich with email for template resolution (e.g., {{assignee.email}})
          if (assignedAgent?.owner_user_id) {
            const ownerUser = db.prepare('SELECT email, name FROM users WHERE id = ?').get(assignedAgent.owner_user_id);
            if (ownerUser) { assignee.email = ownerUser.email; assignee.userName = ownerUser.name; }
          }
          dispatchEvent('task.assigned', {
            project: project ? { id: project.id, name: project.name } : { id: task.project_id },
            projectId: task.project_id,
            task: { id: task.id, title: task.title, priority: task.priority, tags: safeJsonParse(task.tags, []) },
            agent: assignee,
            assignee,
            routing: { ruleId: routingResult.ruleId, decision: routingResult.decision },
            timestamp: new Date().toISOString()
          }).catch(err => console.error('[Dispatcher] Route dispatch error:', err));
        }
      } else {
        // Log once per task so admins know why tasks are stuck (suppressed after first warning per task)
        const ctx = safeJsonParse(task.context, {});
        if (!ctx._routingWarningLogged) {
          console.warn(`[Dispatcher] Task #${task.id} not routed — no matching rules or default agent for project #${task.project_id}. Set up routing: see docs/guides/task-routing.md`);
          ctx._routingWarningLogged = true;
          db.prepare('UPDATE tasks SET context = ? WHERE id = ?').run(JSON.stringify(ctx), task.id);
        }
      }
    }
  } catch (err) {
    console.error('[Dispatcher] Failed to route unassigned tasks:', err);
  }
}

/**
 * Check for overdue tasks and dispatch task.overdue events.
 * Only fires once per task per day to avoid spamming routes.
 */
function checkOverdueTasks() {
  try {
    const overdueTasks = db.prepare(`
      SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date,
             t.project_id, t.assigned_agent_id, t.tags, t.context
      FROM tasks t
      WHERE t.due_date < datetime('now')
        AND t.status NOT IN ('completed', 'cancelled')
        AND t.project_id IS NOT NULL
    `).all();

    if (overdueTasks.length === 0) return;

    const now = new Date();
    for (const task of overdueTasks) {
      // Check if we already fired overdue for this task today
      let context = {};
      try { context = JSON.parse(task.context || '{}'); } catch { context = {}; }
      const lastOverdueNotify = context._lastOverdueNotify;
      if (lastOverdueNotify) {
        const lastDate = new Date(lastOverdueNotify);
        if (now - lastDate < 24 * 60 * 60 * 1000) continue; // Skip — already notified within 24h
      }

      // Mark as notified
      context._lastOverdueNotify = now.toISOString();
      db.prepare('UPDATE tasks SET context = ? WHERE id = ?').run(JSON.stringify(context), task.id);

      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(task.project_id);
      // Build assignee info with email for template resolution (e.g., {{assignee.email}})
      let assignee = null;
      if (task.assigned_agent_id) {
        const agent = db.prepare('SELECT id, name, execution_mode, owner_user_id FROM agents WHERE id = ?').get(task.assigned_agent_id);
        if (agent) {
          assignee = { id: agent.id, name: agent.name, executionMode: agent.execution_mode };
          if (agent.owner_user_id) {
            const ownerUser = db.prepare('SELECT email, name FROM users WHERE id = ?').get(agent.owner_user_id);
            if (ownerUser) { assignee.email = ownerUser.email; assignee.userName = ownerUser.name; }
          }
        }
      }

      dispatchEvent('task.overdue', {
        project: project ? { id: project.id, name: project.name } : { id: task.project_id },
        projectId: task.project_id,
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          due_date: task.due_date,
          tags: safeJsonParse(task.tags, []),
          assigned_agent_id: task.assigned_agent_id,
          assigned_agent_name: assignee?.name || null
        },
        agent: assignee,
        assignee,
        overdue_since: task.due_date,
        timestamp: now.toISOString()
      }).catch(err => console.error('[Dispatcher] Route dispatch error (overdue):', err));
    }

    if (overdueTasks.length > 0) {
      console.log(`[Dispatcher] Checked ${overdueTasks.length} overdue task(s)`);
    }
  } catch (err) {
    console.error('[Dispatcher] Failed to check overdue tasks:', err);
  }
}

/**
 * Main dispatch cycle — called on each interval tick
 */
async function dispatchCycle() {
  if (isRunning) {
    return; // Skip if previous cycle is still running
  }

  isRunning = true;
  try {
    // Fix any count drift before checking for eligible tasks
    reconcileTaskCounts();

    // Re-attempt routing for unassigned tasks
    routeUnassignedTasks();

    // Check for overdue tasks
    checkOverdueTasks();

    const eligible = findEligibleTasks();

    if (eligible.length === 0) {
      return;
    }

    console.log(`[Dispatcher] Found ${eligible.length} task(s) to execute`);

    // Filter out tasks that have a recent execution error (avoid retry loops)
    // Cooldown periods vary by error category — fast for fixable issues, slow for hard failures
    const ERROR_COOLDOWNS_MS = {
      config_error:    5 * 60 * 1000,       // 5 min — credentials/config likely fixed quickly
      auth_error:      5 * 60 * 1000,       // 5 min — API key may have been updated
      rate_limited:    60 * 60 * 1000,       // 60 min — wait for quota window to reset
      quota_exceeded:  6 * 60 * 60 * 1000,   // 6 hours — billing/plan issue
      overloaded:      10 * 60 * 1000,       // 10 min — provider should recover
      timeout:         10 * 60 * 1000,       // 10 min — transient, worth retrying soon
      bad_request:     6 * 60 * 60 * 1000,   // 6 hours — likely needs human fix
      unknown:         6 * 60 * 60 * 1000,   // 6 hours — conservative default
    };
    const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

    const tasksToRun = eligible.filter(e => {
      const task = db.prepare('SELECT context FROM tasks WHERE id = ?').get(e.task_id);
      let context = {};
      try { context = JSON.parse(task?.context || '{}'); } catch { context = {}; }
      if (context.lastExecutionError) {
        const errorTime = new Date(context.lastExecutionError.timestamp).getTime();
        const errorAge = Date.now() - errorTime;
        const category = context.lastExecutionError.category || 'unknown';
        const cooldown = ERROR_COOLDOWNS_MS[category] || DEFAULT_COOLDOWN_MS;

        if (errorAge < cooldown) {
          const remainMin = Math.round((cooldown - errorAge) / 60000);
          console.log(`[Dispatcher] Skipping task #${e.task_id} — ${category} error (retry in ${remainMin}m): ${context.lastExecutionError.error}`);
          return false;
        }
        console.log(`[Dispatcher] Retrying task #${e.task_id} — ${category} error cooldown expired after ${Math.round(errorAge / 60000)}m`);
      }
      return true;
    });

    if (tasksToRun.length === 0) {
      console.log(`[Dispatcher] All ${eligible.length} eligible task(s) skipped (previous errors)`);
      return;
    }

    // Execute tasks sequentially to avoid overwhelming providers
    for (const task of tasksToRun) {
      await dispatchTask(task);
    }
  } catch (err) {
    console.error('[Dispatcher] Cycle error:', err);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the dispatcher background loop
 */
export function startDispatcher() {
  if (intervalHandle) {
    console.log('[Dispatcher] Already running');
    return;
  }

  console.log(`[Dispatcher] Starting — polling every ${POLL_INTERVAL_MS / 1000}s, batch size ${MAX_BATCH_SIZE}`);

  // Run once immediately on startup
  setTimeout(() => dispatchCycle(), 5000); // 5s delay to let server fully start

  // Then run on interval
  intervalHandle = setInterval(dispatchCycle, POLL_INTERVAL_MS);
}

/**
 * Stop the dispatcher
 */
export function stopDispatcher() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[Dispatcher] Stopped');
  }
}

/**
 * Manually trigger execution of a specific task (for UI "Execute Now" button)
 * Returns the result directly rather than going through the queue.
 */
export async function executeTaskNow(taskId) {
  const task = db.prepare(`
    SELECT t.*, a.name as agent_name
    FROM tasks t
    LEFT JOIN agents a ON a.id = t.assigned_agent_id
    WHERE t.id = ?
  `).get(taskId);

  if (!task) throw new Error('Task not found');
  if (!task.assigned_agent_id) throw new Error('Task is not assigned to an agent');

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(task.assigned_agent_id);
  if (!agent) throw new Error('Assigned agent not found');
  if (!agent.provider || !agent.provider_api_key_encrypted) {
    throw new Error('Agent does not have task execution configured. Go to Manage > Task Execution to set up a provider.');
  }

  // Increment active_task_count while executing
  incrementActiveTaskCount(agent.id);

  // Log start
  logAgentActivity(agent.id, 'task.execution_started', 'task', taskId, {
    title: task.title,
    trigger: 'manual'
  });
  logActivity('task', taskId, 'execution_started', 'system', {
    agentId: agent.id,
    agentName: agent.name,
    trigger: 'manual'
  });

  let result;
  try {
    result = await executeTask(agent, task);
  } catch (err) {
    decrementActiveTaskCount(agent.id);
    throw err;
  }

  // Decrement active_task_count — execution finished
  decrementActiveTaskCount(agent.id);

  if (result.success) {
    logAgentActivity(agent.id, 'task.execution_completed', 'task', taskId, {
      title: task.title,
      deliverableId: result.deliverableId,
      usage: result.usage
    });
    logActivity('task', taskId, 'execution_completed', 'system', {
      agentId: agent.id,
      agentName: agent.name,
      deliverableId: result.deliverableId,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens
    });
    logActivity('deliverable', result.deliverableId, 'created', agent.name, {
      taskId: taskId,
      taskTitle: task.title,
      trigger: 'manual'
    });
  } else {
    logAgentActivity(agent.id, 'task.execution_failed', 'task', taskId, {
      title: task.title,
      error: result.error
    });
    logActivity('task', taskId, 'execution_failed', 'system', {
      agentId: agent.id,
      agentName: agent.name,
      error: result.error
    });

    // Flag the task so it doesn't stay stuck at in_progress
    flagTaskError(taskId, agent.name, result.error, result.category);

    // Dispatch task.execution_failed event to delivery routes
    if (task.project_id) {
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(task.project_id);
      dispatchEvent('task.execution_failed', {
        project: project ? { id: project.id, name: project.name } : { id: task.project_id },
        projectId: task.project_id,
        task: { id: taskId, title: task.title },
        error: result.error,
        errorCategory: result.category || classifyErrorMessage(result.error),
        agentName: agent.name,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Dispatcher] Route dispatch error:', err));
    }
  }

  return result;
}

/**
 * Get dispatcher status (for health checks / UI)
 */
export function getDispatcherStatus() {
  const pendingAutoTasks = db.prepare(`
    SELECT COUNT(*) as count
    FROM tasks t
    JOIN agents a ON a.id = t.assigned_agent_id
    WHERE t.status IN ('pending', 'assigned')
      AND a.execution_mode = 'auto'
      AND a.status = 'active'
      AND a.provider IS NOT NULL
      AND a.provider_api_key_encrypted IS NOT NULL
  `).get();

  const recentExecutions = db.prepare(`
    SELECT COUNT(*) as count
    FROM activity_log
    WHERE event_type IN ('execution_started', 'execution_completed', 'execution_failed')
      AND created_at >= datetime('now', '-1 hour')
  `).get();

  const unroutedTasks = db.prepare(`
    SELECT COUNT(*) as count FROM tasks
    WHERE status = 'pending' AND assigned_agent_id IS NULL AND project_id IS NOT NULL
  `).get();

  const recentErrors = db.prepare(`
    SELECT al.entity_id as task_id, al.detail, al.created_at
    FROM activity_log al
    WHERE al.event_type = 'execution_failed'
      AND al.created_at >= datetime('now', '-24 hours')
    ORDER BY al.created_at DESC
    LIMIT 10
  `).all();

  return {
    running: !!intervalHandle,
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: MAX_BATCH_SIZE,
    pendingAutoTasks: pendingAutoTasks.count,
    unroutedTasks: unroutedTasks.count,
    executionsLastHour: recentExecutions.count,
    recentErrors: recentErrors.map(e => ({
      taskId: e.task_id,
      detail: (() => { try { return JSON.parse(e.detail || '{}'); } catch { return {}; } })(),
      createdAt: e.created_at
    }))
  };
}
