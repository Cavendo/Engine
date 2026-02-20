import { Router } from 'express';
import db from '../db/connection.js';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { dualAuth } from '../middleware/agentAuth.js';
import {
  validateBody,
  createSprintSchema,
  updateSprintSchema,
  addTaskToSprintSchema
} from '../utils/validation.js';

const router = Router();

function safeJsonParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
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
 * Normalize timestamp fields on a sprint object
 */
function normalizeSprintTimestamps(sprint) {
  return {
    ...sprint,
    start_date: toISOTimestamp(sprint.start_date),
    end_date: toISOTimestamp(sprint.end_date),
    created_at: toISOTimestamp(sprint.created_at),
    updated_at: toISOTimestamp(sprint.updated_at)
  };
}

/**
 * Get task summary counts for a sprint
 */
function getTaskSummary(sprintId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review,
      SUM(CASE WHEN status = 'pending' OR status = 'assigned' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
    FROM tasks WHERE sprint_id = ?
  `).get(sprintId);
}

// ============================================
// List and Read endpoints (dualAuth)
// ============================================

/**
 * GET /api/sprints
 * List all sprints with filtering
 */
router.get('/', dualAuth, (req, res) => {
  try {
    const { status, projectId } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = `
      SELECT
        s.*,
        p.name as project_name
      FROM sprints s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND s.status = ?';
      params.push(status);
    }
    if (projectId) {
      query += ' AND s.project_id = ?';
      params.push(parseInt(projectId));
    }

    query += ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const sprints = db.prepare(query).all(...params);

    // Get task summary for each sprint
    const sprintsWithSummary = sprints.map(sprint => {
      const taskSummary = getTaskSummary(sprint.id);
      return normalizeSprintTimestamps({
        ...sprint,
        taskSummary
      });
    });

    response.success(res, sprintsWithSummary);
  } catch (err) {
    console.error('Error listing sprints:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/sprints/:id
 * Get sprint details with task summary
 */
router.get('/:id', dualAuth, (req, res) => {
  try {
    const sprint = db.prepare(`
      SELECT
        s.*,
        p.name as project_name
      FROM sprints s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?
    `).get(req.params.id);

    if (!sprint) {
      return response.notFound(res, 'Sprint');
    }

    // Get task summary
    const taskSummary = getTaskSummary(sprint.id);

    response.success(res, normalizeSprintTimestamps({
      ...sprint,
      taskSummary
    }));
  } catch (err) {
    console.error('Error getting sprint:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/sprints/:id/tasks
 * Get all tasks in a sprint
 */
router.get('/:id/tasks', dualAuth, (req, res) => {
  try {
    const sprint = db.prepare('SELECT id, name FROM sprints WHERE id = ?').get(req.params.id);
    if (!sprint) {
      return response.notFound(res, 'Sprint');
    }

    const { status, priority } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = `
      SELECT
        t.*,
        p.name as project_name,
        a.name as agent_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN agents a ON a.id = t.assigned_agent_id
      WHERE t.sprint_id = ?
    `;
    const params = [req.params.id];

    if (status) {
      query += ' AND t.status = ?';
      params.push(status);
    }
    if (priority) {
      query += ' AND t.priority = ?';
      params.push(parseInt(priority));
    }

    query += ' ORDER BY t.priority ASC, t.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const tasks = db.prepare(query).all(...params);

    const parsed = tasks.map(task => ({
      ...task,
      context: safeJsonParse(task.context, {}),
      created_at: toISOTimestamp(task.created_at),
      updated_at: toISOTimestamp(task.updated_at),
      due_date: toISOTimestamp(task.due_date),
      completed_at: toISOTimestamp(task.completed_at),
      assigned_at: toISOTimestamp(task.assigned_at),
      started_at: toISOTimestamp(task.started_at)
    }));

    response.success(res, {
      sprint: normalizeSprintTimestamps(sprint),
      tasks: parsed
    });
  } catch (err) {
    console.error('Error getting sprint tasks:', err);
    response.serverError(res);
  }
});

// ============================================
// Admin endpoints (require user authentication)
// ============================================

/**
 * POST /api/sprints
 * Create a new sprint
 */
router.post('/', userAuth, requireRoles('admin'), validateBody(createSprintSchema), (req, res) => {
  try {
    const { name, description, projectId, status, startDate, endDate, goal } = req.body;

    // Validate project exists if provided
    if (projectId) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!project) {
        return response.validationError(res, 'Invalid project ID');
      }
    }

    const result = db.prepare(`
      INSERT INTO sprints (name, description, project_id, status, start_date, end_date, goal)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      description || null,
      projectId || null,
      status || 'planning',
      startDate || null,
      endDate || null,
      goal || null
    );

    const sprint = db.prepare('SELECT * FROM sprints WHERE id = ?').get(result.lastInsertRowid);

    response.created(res, normalizeSprintTimestamps(sprint));
  } catch (err) {
    console.error('Error creating sprint:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/sprints/:id
 * Update sprint
 */
router.patch('/:id', userAuth, requireRoles('admin'), validateBody(updateSprintSchema), (req, res) => {
  try {
    const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(req.params.id);
    if (!sprint) {
      return response.notFound(res, 'Sprint');
    }

    const { name, description, projectId, status, startDate, endDate, goal } = req.body;

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
    if (projectId !== undefined) {
      if (projectId !== null) {
        const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
        if (!project) {
          return response.validationError(res, 'Invalid project ID');
        }
      }
      updates.push('project_id = ?');
      values.push(projectId);
    }
    if (status !== undefined) {
      const validStatuses = ['planning', 'active', 'completed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return response.validationError(res, `Status must be one of: ${validStatuses.join(', ')}`);
      }
      updates.push('status = ?');
      values.push(status);
    }
    if (startDate !== undefined) {
      updates.push('start_date = ?');
      values.push(startDate);
    }
    if (endDate !== undefined) {
      updates.push('end_date = ?');
      values.push(endDate);
    }
    if (goal !== undefined) {
      updates.push('goal = ?');
      values.push(goal);
    }

    if (updates.length === 0) {
      return response.validationError(res, 'No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    db.prepare(`UPDATE sprints SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare(`
      SELECT s.*, p.name as project_name
      FROM sprints s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = ?
    `).get(req.params.id);

    const taskSummary = getTaskSummary(req.params.id);

    response.success(res, normalizeSprintTimestamps({
      ...updated,
      taskSummary
    }));
  } catch (err) {
    console.error('Error updating sprint:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/sprints/:id
 * Delete sprint
 */
router.delete('/:id', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(req.params.id);
    if (!sprint) {
      return response.notFound(res, 'Sprint');
    }

    // Clear sprint_id from associated tasks (don't delete tasks)
    db.prepare('UPDATE tasks SET sprint_id = NULL WHERE sprint_id = ?').run(req.params.id);

    // Delete the sprint
    db.prepare('DELETE FROM sprints WHERE id = ?').run(req.params.id);

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting sprint:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/sprints/:id/tasks
 * Add a task to a sprint
 */
router.post('/:id/tasks', userAuth, requireRoles('admin'), validateBody(addTaskToSprintSchema), (req, res) => {
  try {
    const sprint = db.prepare('SELECT id, project_id FROM sprints WHERE id = ?').get(req.params.id);
    if (!sprint) {
      return response.notFound(res, 'Sprint');
    }

    const { taskId } = req.body;

    const task = db.prepare('SELECT id, sprint_id FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      return response.validationError(res, 'Invalid task ID');
    }

    if (task.sprint_id === parseInt(req.params.id)) {
      return response.validationError(res, 'Task is already in this sprint');
    }

    db.prepare(`
      UPDATE tasks SET sprint_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(req.params.id, taskId);

    const updatedTask = db.prepare(`
      SELECT
        t.*,
        p.name as project_name,
        a.name as agent_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN agents a ON a.id = t.assigned_agent_id
      WHERE t.id = ?
    `).get(taskId);

    response.success(res, {
      ...updatedTask,
      context: safeJsonParse(updatedTask.context, {}),
      created_at: toISOTimestamp(updatedTask.created_at),
      updated_at: toISOTimestamp(updatedTask.updated_at),
      due_date: toISOTimestamp(updatedTask.due_date),
      completed_at: toISOTimestamp(updatedTask.completed_at),
      assigned_at: toISOTimestamp(updatedTask.assigned_at),
      started_at: toISOTimestamp(updatedTask.started_at)
    });
  } catch (err) {
    console.error('Error adding task to sprint:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/sprints/:id/tasks/:taskId
 * Remove a task from a sprint
 */
router.delete('/:id/tasks/:taskId', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const sprint = db.prepare('SELECT id FROM sprints WHERE id = ?').get(req.params.id);
    if (!sprint) {
      return response.notFound(res, 'Sprint');
    }

    const task = db.prepare('SELECT id, sprint_id FROM tasks WHERE id = ?').get(req.params.taskId);
    if (!task) {
      return response.notFound(res, 'Task');
    }

    if (task.sprint_id !== parseInt(req.params.id)) {
      return response.validationError(res, 'Task is not in this sprint');
    }

    db.prepare(`
      UPDATE tasks SET sprint_id = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(req.params.taskId);

    response.success(res, { removed: true });
  } catch (err) {
    console.error('Error removing task from sprint:', err);
    response.serverError(res);
  }
});

export default router;
