import { Router } from 'express';
import db from '../db/adapter.js';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { dualAuth } from '../middleware/agentAuth.js';
import { dispatchEvent } from '../services/routeDispatcher.js';
import {
  validateBody,
  createProjectSchema,
  updateProjectSchema,
  routingRulesSchema,
  routingTestSchema
} from '../utils/validation.js';
import { evaluateRoutingRules, checkAgentAvailability } from '../services/taskRouter.js';

const router = Router();

function safeJsonParse(str, defaultValue = null) {
  if (str === null || str === undefined) return defaultValue;
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return defaultValue; }
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
 * Normalize timestamp fields on a project object
 */
function normalizeProjectTimestamps(project) {
  return {
    ...project,
    created_at: toISOTimestamp(project.created_at),
    updated_at: toISOTimestamp(project.updated_at)
  };
}

/**
 * GET /api/projects
 * List all projects (accessible by both users and agents)
 */
router.get('/', dualAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = 'SELECT * FROM projects WHERE 1=1';
    const params = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const projects = await db.many(query, params);

    // Get task counts for each project
    const projectsWithCounts = [];
    for (const project of projects) {
      const counts = await db.one(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status IN ('in_progress', 'review') THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status IN ('pending', 'assigned') THEN 1 ELSE 0 END) as pending
        FROM tasks WHERE project_id = ?
      `, [project.id]);

      projectsWithCounts.push(normalizeProjectTimestamps({
        ...project,
        taskCounts: counts
      }));
    }

    response.success(res, projectsWithCounts);
  } catch (err) {
    console.error('Error listing projects:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/projects
 * Create a new project
 */
router.post('/', userAuth, requireRoles('admin'), validateBody(createProjectSchema), async (req, res) => {
  try {
    const { name, description } = req.body;

    const { lastInsertRowid: id } = await db.insert(`
      INSERT INTO projects (name, description)
      VALUES (?, ?)
    `, [name, description || null]);

    const project = await db.one('SELECT * FROM projects WHERE id = ?', [id]);

    // Dispatch project.created event
    dispatchEvent('project.created', {
      project: { id: project.id, name: project.name },
      projectId: project.id,
      description: project.description || null,
      createdBy: req.user?.name || req.user?.email || 'admin',
      timestamp: new Date().toISOString()
    }).catch(err => console.error('[Projects] Route dispatch error:', err));

    response.created(res, normalizeProjectTimestamps(project));
  } catch (err) {
    console.error('Error creating project:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/projects/:id
 * Get project details (accessible by both users and agents)
 */
router.get('/:id', dualAuth, async (req, res) => {
  try {
    const project = await db.one('SELECT * FROM projects WHERE id = ?', [req.params.id]);

    if (!project) {
      return response.notFound(res, 'Project');
    }

    // Get tasks
    const tasks = await db.many(`
      SELECT id, title, status, priority, assigned_agent_id
      FROM tasks
      WHERE project_id = ?
      ORDER BY priority ASC, created_at DESC
    `, [req.params.id]);

    // Get knowledge count
    const knowledgeCountRow = await db.one(`
      SELECT COUNT(*) as count FROM knowledge WHERE project_id = ?
    `, [req.params.id]);
    const knowledgeCount = knowledgeCountRow.count;

    response.success(res, normalizeProjectTimestamps({
      ...project,
      tasks,
      knowledgeCount
    }));
  } catch (err) {
    console.error('Error getting project:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/projects/:id
 * Update project
 */
router.patch('/:id', userAuth, requireRoles('admin'), validateBody(updateProjectSchema), async (req, res) => {
  try {
    const project = await db.one('SELECT id FROM projects WHERE id = ?', [req.params.id]);
    if (!project) {
      return response.notFound(res, 'Project');
    }

    const { name, description, status } = req.body;

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (status !== undefined) {
      const validStatuses = ['active', 'archived', 'completed'];
      if (!validStatuses.includes(status)) {
        return response.validationError(res, `Status must be one of: ${validStatuses.join(', ')}`);
      }
      updates.push('status = ?');
      values.push(status);
    }

    if (updates.length === 0) {
      return response.validationError(res, 'No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    await db.exec(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, values);

    const updated = await db.one('SELECT * FROM projects WHERE id = ?', [req.params.id]);

    response.success(res, normalizeProjectTimestamps(updated));
  } catch (err) {
    console.error('Error updating project:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/projects/:id
 * Delete project
 */
router.delete('/:id', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const project = await db.one('SELECT id FROM projects WHERE id = ?', [req.params.id]);
    if (!project) {
      return response.notFound(res, 'Project');
    }

    // Check for associated tasks
    const taskCountRow = await db.one('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?', [req.params.id]);
    const taskCount = taskCountRow.count;
    if (taskCount > 0) {
      return response.validationError(res, `Cannot delete project with ${taskCount} associated tasks`);
    }

    await db.exec('DELETE FROM projects WHERE id = ?', [req.params.id]);

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting project:', err);
    response.serverError(res);
  }
});

// ============================================
// Agent-accessible project endpoints
// ============================================

/**
 * GET /api/projects/:id/knowledge
 * Get project knowledge base (accessible by agents)
 */
router.get('/:id/knowledge', dualAuth, async (req, res) => {
  try {
    const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [req.params.id]);
    if (!project) {
      return response.notFound(res, 'Project');
    }

    const { category, search } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = `
      SELECT id, title, content, content_type, category, tags, created_at, updated_at
      FROM knowledge
      WHERE project_id = ?
    `;
    const params = [req.params.id];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    if (search) {
      query += ' AND (title LIKE ? OR content LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const knowledge = await db.many(query, params);

    const parsed = knowledge.map(k => ({
      ...k,
      tags: safeJsonParse(k.tags, []),
      created_at: toISOTimestamp(k.created_at),
      updated_at: toISOTimestamp(k.updated_at)
    }));

    response.success(res, {
      project: normalizeProjectTimestamps(project),
      knowledge: parsed
    });
  } catch (err) {
    console.error('Error getting project knowledge:', err);
    response.serverError(res);
  }
});

// ============================================
// Routing Rules Endpoints
// ============================================

/**
 * GET /api/projects/:id/routing-rules
 * Get project routing rules configuration
 */
router.get('/:id/routing-rules', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const project = await db.one('SELECT id, task_routing_rules, default_agent_id FROM projects WHERE id = ?', [req.params.id]);
    if (!project) {
      return response.notFound(res, 'Project');
    }

    // Parse task_routing_rules from JSON
    let taskRoutingRules = [];
    if (project.task_routing_rules) {
      try {
        taskRoutingRules = JSON.parse(project.task_routing_rules);
      } catch (e) {
        console.error('Error parsing task_routing_rules:', e);
        taskRoutingRules = [];
      }
    }

    // Get default agent name if set
    let defaultAgent = null;
    if (project.default_agent_id) {
      defaultAgent = await db.one('SELECT id, name, status FROM agents WHERE id = ?', [project.default_agent_id]);
    }

    response.success(res, {
      task_routing_rules: taskRoutingRules,
      default_agent_id: project.default_agent_id,
      default_agent: defaultAgent
    });
  } catch (err) {
    console.error('Error getting project routing rules:', err);
    response.serverError(res);
  }
});

/**
 * PUT /api/projects/:id/routing-rules
 * Update project routing rules configuration
 */
router.put('/:id/routing-rules', userAuth, requireRoles('admin'), validateBody(routingRulesSchema), async (req, res) => {
  try {
    const project = await db.one('SELECT id FROM projects WHERE id = ?', [req.params.id]);
    if (!project) {
      return response.notFound(res, 'Project');
    }

    const { task_routing_rules, default_agent_id } = req.body;

    // Validate default_agent_id exists if provided
    if (default_agent_id) {
      const agent = await db.one('SELECT id FROM agents WHERE id = ?', [default_agent_id]);
      if (!agent) {
        return response.validationError(res, `Agent with ID ${default_agent_id} not found`);
      }
    }

    // Validate rule structure and agent IDs (assign_to and fallback_to)
    if (task_routing_rules && task_routing_rules.length > 0) {
      for (const rule of task_routing_rules) {
        // Validate assign_to agent exists if specified
        if (rule.assign_to) {
          const agent = await db.one('SELECT id FROM agents WHERE id = ?', [rule.assign_to]);
          if (!agent) {
            return response.validationError(res, `Agent with ID ${rule.assign_to} in rule "${rule.name}" not found`);
          }
        }
        // Validate fallback_to agent exists if specified
        if (rule.fallback_to) {
          const fallbackAgent = await db.one('SELECT id FROM agents WHERE id = ?', [rule.fallback_to]);
          if (!fallbackAgent) {
            return response.validationError(res, `Fallback agent with ID ${rule.fallback_to} in rule "${rule.name}" not found`);
          }
        }
      }
    }

    // Store task_routing_rules as JSON string
    const rulesJson = task_routing_rules ? JSON.stringify(task_routing_rules) : null;

    await db.exec(`
      UPDATE projects
      SET task_routing_rules = ?, default_agent_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `, [rulesJson, default_agent_id || null, req.params.id]);

    // Fetch updated project
    const updated = await db.one('SELECT id, task_routing_rules, default_agent_id FROM projects WHERE id = ?', [req.params.id]);

    // Get default agent info
    let defaultAgent = null;
    if (updated.default_agent_id) {
      defaultAgent = await db.one('SELECT id, name, status FROM agents WHERE id = ?', [updated.default_agent_id]);
    }

    response.success(res, {
      task_routing_rules: task_routing_rules || [],
      default_agent_id: updated.default_agent_id,
      default_agent: defaultAgent
    });
  } catch (err) {
    console.error('Error updating project routing rules:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/projects/:id/routing-rules/test
 * Test routing rules with a simulated task (dry run)
 */
router.post('/:id/routing-rules/test', userAuth, requireRoles('admin'), validateBody(routingTestSchema), async (req, res) => {
  try {
    const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [req.params.id]);
    if (!project) {
      return response.notFound(res, 'Project');
    }

    const { tags, priority, metadata } = req.body;

    // Build simulated task with context for routing evaluation
    const simulatedTask = {
      tags: tags || [],
      priority: priority || 2,
      context: metadata || {}
    };

    // Evaluate routing rules (function loads rules from project internally)
    const routingResult = await evaluateRoutingRules(parseInt(req.params.id), simulatedTask);

    // Build response
    let agentInfo = null;
    if (routingResult.matched && routingResult.agentId) {
      const agent = await db.one('SELECT id, name, status, active_task_count, max_concurrent_tasks FROM agents WHERE id = ?', [routingResult.agentId]);
      if (agent) {
        agentInfo = {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          currentLoad: `${agent.active_task_count || 0}/${agent.max_concurrent_tasks || 'unlimited'}`
        };
      }
    }

    response.success(res, {
      matched: routingResult.matched,
      agentId: routingResult.agentId || null,
      agent: agentInfo,
      ruleId: routingResult.ruleId || null,
      ruleName: routingResult.ruleName || null,
      decision: routingResult.decision
    });
  } catch (err) {
    console.error('Error testing routing rules:', err);
    response.serverError(res);
  }
});

export default router;
