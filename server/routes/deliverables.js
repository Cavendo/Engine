import { Router } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import db from '../db/connection.js';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { agentAuth, dualAuth, logAgentActivity } from '../middleware/agentAuth.js';
import { triggerWebhook } from '../services/webhooks.js';
import { dispatchEvent } from '../services/routeDispatcher.js';
import { logActivity } from '../services/activityLogger.js';
import { canAccessDeliverable } from '../utils/authorization.js';
import {
  validateBody,
  submitDeliverableSchema,
  submitRevisionSchema,
  reviewDeliverableSchema
} from '../utils/validation.js';
import { insertDeliverableWithRetry } from '../utils/deliverableVersioning.js';

const router = Router();

/**
 * Safely parse JSON with a default fallback
 * Prevents crashes from malformed JSON in database
 */
function safeJsonParse(jsonString, defaultValue = null) {
  if (jsonString === null || jsonString === undefined) return defaultValue;
  if (typeof jsonString !== 'string') return jsonString;
  try {
    return JSON.parse(jsonString);
  } catch (err) {
    console.error('[Deliverables] JSON parse error:', err.message);
    return defaultValue;
  }
}

/**
 * Convert SQLite timestamp to ISO 8601 format with explicit UTC marker.
 * SQLite stores timestamps like "2026-02-11 16:36:31" (UTC but no Z suffix).
 * JavaScript needs the Z suffix to correctly interpret as UTC.
 * @param {string} timestamp - SQLite timestamp string
 * @returns {string|null} ISO 8601 timestamp with Z suffix, or null
 */
function toISOTimestamp(timestamp) {
  if (!timestamp) return null;
  // If already has Z or timezone offset, return as-is
  if (timestamp.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp)) {
    return timestamp;
  }
  // Convert "YYYY-MM-DD HH:MM:SS" to "YYYY-MM-DDTHH:MM:SS.000Z"
  const isoString = timestamp.replace(' ', 'T');
  return isoString.includes('.') ? `${isoString}Z` : `${isoString}.000Z`;
}

/**
 * Convert all timestamp fields in a deliverable object to ISO format
 * @param {object} d - Deliverable object from database
 * @returns {object} Deliverable with ISO timestamps
 */
function normalizeTimestamps(d) {
  return {
    ...d,
    created_at: toISOTimestamp(d.created_at),
    updated_at: toISOTimestamp(d.updated_at),
  };
}

// Uploads directory for file attachments
const UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');

// File size limits
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_FILES_SIZE = 50 * 1024 * 1024; // 50MB total

// Ensure uploads directory exists
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(console.error);

/**
 * Get MIME type from filename extension
 */
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.xml': 'application/xml',
    '.zip': 'application/zip',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Save file attachment to disk
 */
async function saveFile(filename, content, deliverableId) {
  const deliverableDir = path.join(UPLOADS_DIR, 'deliverables', String(deliverableId));
  await fs.mkdir(deliverableDir, { recursive: true });

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(deliverableDir, safeName);

  // Check if content is base64 encoded
  if (content.startsWith('base64:')) {
    const base64Data = content.slice(7);
    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));
  } else {
    await fs.writeFile(filePath, content, 'utf8');
  }

  const stats = await fs.stat(filePath);
  return {
    filename: safeName,
    path: `/uploads/deliverables/${deliverableId}/${safeName}`,
    size: stats.size
  };
}

// ============================================
// Admin endpoints (require user authentication)
// ============================================

/**
 * GET /api/deliverables
 * List all deliverables with filtering
 */
router.get('/', userAuth, (req, res) => {
  try {
    const { status, taskId, agentId, projectId } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = `
      SELECT
        d.*,
        t.title as task_title,
        a.name as agent_name
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      LEFT JOIN agents a ON a.id = d.agent_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND d.status = ?';
      params.push(status);
    }
    if (taskId) {
      query += ' AND d.task_id = ?';
      params.push(parseInt(taskId));
    }
    if (agentId) {
      query += ' AND d.agent_id = ?';
      params.push(parseInt(agentId));
    }
    if (projectId) {
      query += ' AND (d.project_id = ? OR d.task_id IN (SELECT id FROM tasks WHERE project_id = ?))';
      params.push(parseInt(projectId), parseInt(projectId));
    }

    query += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const deliverables = db.prepare(query).all(...params);

    const parsed = deliverables.map(d => ({
      ...normalizeTimestamps(d),
      files: safeJsonParse(d.files, []),
      actions: safeJsonParse(d.actions, []),
      metadata: safeJsonParse(d.metadata, {})
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error listing deliverables:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/deliverables/pending
 * List deliverables pending review
 */
router.get('/pending', userAuth, (req, res) => {
  try {
    const deliverables = db.prepare(`
      SELECT
        d.*,
        t.title as task_title,
        COALESCE(d.project_id, t.project_id) as resolved_project_id,
        COALESCE(p1.name, p2.name) as project_name,
        a.name as agent_name
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      LEFT JOIN projects p1 ON p1.id = d.project_id
      LEFT JOIN projects p2 ON p2.id = t.project_id
      LEFT JOIN agents a ON a.id = d.agent_id
      WHERE d.status = 'pending'
      ORDER BY d.created_at ASC
    `).all();

    const parsed = deliverables.map(d => ({
      ...normalizeTimestamps(d),
      project_id: d.resolved_project_id,
      files: safeJsonParse(d.files, []),
      actions: safeJsonParse(d.actions, []),
      metadata: safeJsonParse(d.metadata, {})
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error listing pending deliverables:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/deliverables/mine
 * Get deliverables submitted by current agent or user
 * - For agent keys: returns deliverables where agent_id matches
 * - For user keys: returns deliverables from agents owned by this user
 */
router.get('/mine', agentAuth, (req, res) => {
  try {
    const { status } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query;
    let params;

    if (req.agent.id) {
      // Agent key: query by agent_id
      query = `
        SELECT
          d.*,
          t.title as task_title,
          COALESCE(p1.name, p2.name) as project_name
        FROM deliverables d
        LEFT JOIN tasks t ON t.id = d.task_id
        LEFT JOIN projects p1 ON p1.id = d.project_id
        LEFT JOIN projects p2 ON p2.id = t.project_id
        WHERE d.agent_id = ?
      `;
      params = [req.agent.id];
    } else if (req.agent.isUserKey && req.agent.userId) {
      // User key: query deliverables from agents owned by this user OR submitted directly by user
      query = `
        SELECT
          d.*,
          t.title as task_title,
          COALESCE(p1.name, p2.name) as project_name,
          a.name as agent_name
        FROM deliverables d
        LEFT JOIN tasks t ON t.id = d.task_id
        LEFT JOIN projects p1 ON p1.id = d.project_id
        LEFT JOIN projects p2 ON p2.id = t.project_id
        LEFT JOIN agents a ON a.id = d.agent_id
        WHERE d.submitted_by_user_id = ?
           OR d.agent_id IN (SELECT id FROM agents WHERE owner_user_id = ?)
      `;
      params = [req.agent.userId, req.agent.userId];
    } else {
      // No valid identity to query by
      return response.validationError(res, 'Session required');
    }

    if (status) {
      query += ' AND d.status = ?';
      params.push(status);
    }

    query += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const deliverables = db.prepare(query).all(...params);

    const parsed = deliverables.map(d => ({
      ...normalizeTimestamps(d),
      files: safeJsonParse(d.files, []),
      actions: safeJsonParse(d.actions, []),
      metadata: safeJsonParse(d.metadata, {})
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error getting agent deliverables:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/deliverables/:id
 * Get deliverable details
 * Supports both user auth (session/user keys) and agent auth (agent keys)
 */
router.get('/:id', dualAuth, (req, res) => {
  try {
    // Authorization check
    const access = canAccessDeliverable(req, req.params.id);
    if (!access.allowed) {
      return access.reason === 'not_found'
        ? response.notFound(res, 'Deliverable')
        : response.forbidden(res, 'Access denied');
    }

    const deliverable = db.prepare(`
      SELECT
        d.*,
        t.title as task_title,
        t.description as task_description,
        COALESCE(d.project_id, t.project_id) as resolved_project_id,
        COALESCE(p1.name, p2.name) as project_name,
        a.name as agent_name
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      LEFT JOIN projects p1 ON p1.id = d.project_id
      LEFT JOIN projects p2 ON p2.id = t.project_id
      LEFT JOIN agents a ON a.id = d.agent_id
      WHERE d.id = ?
    `).get(req.params.id);

    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    // Get version history (for task-linked deliverables)
    let versions = [];
    if (deliverable.task_id) {
      versions = db.prepare(`
        SELECT id, version, status, created_at, reviewed_at
        FROM deliverables
        WHERE task_id = ?
        ORDER BY version DESC
      `).all(deliverable.task_id).map(v => ({
        ...v,
        created_at: toISOTimestamp(v.created_at),
        reviewed_at: toISOTimestamp(v.reviewed_at)
      }));
    }

    response.success(res, {
      ...normalizeTimestamps(deliverable),
      project_id: deliverable.resolved_project_id,
      files: safeJsonParse(deliverable.files, []),
      actions: safeJsonParse(deliverable.actions, []),
      metadata: safeJsonParse(deliverable.metadata, {}),
      versions
    });
  } catch (err) {
    console.error('Error getting deliverable:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/deliverables/:id/feedback
 * Get feedback for a deliverable (for revisions)
 */
router.get('/:id/feedback', dualAuth, (req, res) => {
  try {
    const deliverable = db.prepare(`
      SELECT id, task_id, agent_id, status, feedback, reviewed_by, reviewed_at
      FROM deliverables
      WHERE id = ?
    `).get(req.params.id);

    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    // Authorization check
    if (req.agent) {
      // Agent auth: verify this deliverable belongs to them
      if (req.agent.id && deliverable.agent_id !== req.agent.id) {
        return response.forbidden(res, 'Deliverable not created by this agent');
      }
      // User keys (isUserKey=true) can access if they're admin
      if (req.agent.isUserKey && req.agent.userRole !== 'admin') {
        return response.forbidden(res, 'Admin access required');
      }
    } else if (req.user) {
      // User session auth: must be admin
      if (req.user.role !== 'admin') {
        return response.forbidden(res, 'Admin access required');
      }
    }

    response.success(res, {
      id: deliverable.id,
      status: deliverable.status,
      feedback: deliverable.feedback,
      reviewedBy: deliverable.reviewed_by,
      reviewedAt: toISOTimestamp(deliverable.reviewed_at)
    });
  } catch (err) {
    console.error('Error getting deliverable feedback:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/deliverables/:id/review
 * Review a deliverable (approve/revise/reject)
 * Works for both task-linked and standalone deliverables
 */
router.patch('/:id/review', userAuth, requireRoles('admin', 'reviewer'), validateBody(reviewDeliverableSchema), (req, res) => {
  try {
    const deliverable = db.prepare(`
      SELECT d.*, t.assigned_agent_id
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ?
    `).get(req.params.id);

    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    if (deliverable.status !== 'pending') {
      return response.validationError(res, 'Deliverable has already been reviewed');
    }

    const { decision, feedback } = req.body;

    db.prepare(`
      UPDATE deliverables
      SET status = ?, feedback = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(decision, feedback || null, req.user.email, req.params.id);

    // Log activity
    logActivity('deliverable', parseInt(req.params.id), 'status_changed', req.user.name || req.user.email, { from: 'pending', to: decision });
    if (decision === 'revision_requested' && feedback) {
      logActivity('deliverable', parseInt(req.params.id), 'revision_requested', req.user.name || req.user.email, { feedback: feedback.substring(0, 200) });
    }

    // Update task status based on review decision
    if (deliverable.task_id) {
      if (decision === 'approved') {
        db.prepare(`
          UPDATE tasks
          SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(deliverable.task_id);

        // Log task completion in activity trail
        logActivity('task', deliverable.task_id, 'completed', req.user.name || req.user.email, {
          completedVia: 'deliverable_approval',
          deliverableId: parseInt(req.params.id)
        });
      } else if (decision === 'revision_requested') {
        // Reset task to assigned so agent/dispatcher can re-execute
        db.prepare(`
          UPDATE tasks
          SET status = 'assigned', updated_at = datetime('now')
          WHERE id = ?
        `).run(deliverable.task_id);
      } else if (decision === 'rejected') {
        db.prepare(`
          UPDATE tasks
          SET status = 'assigned', updated_at = datetime('now')
          WHERE id = ?
        `).run(deliverable.task_id);
      }
    }

    const updated = db.prepare('SELECT * FROM deliverables WHERE id = ?').get(req.params.id);

    // Trigger webhook (use agent_id from deliverable if no task assignment)
    const webhookAgentId = deliverable.assigned_agent_id || deliverable.agent_id;
    if (webhookAgentId) {
      const eventType = `deliverable.${decision}`;
      triggerWebhook(webhookAgentId, eventType, {
        deliverable: {
          ...updated,
          files: safeJsonParse(updated.files, []),
          actions: safeJsonParse(updated.actions, []),
          metadata: safeJsonParse(updated.metadata, {})
        },
        taskId: deliverable.task_id
      });
    }

    // Dispatch to delivery routes
    // Resolve project_id: check deliverable first, then fall back to task's project_id
    let projectId = updated.project_id || deliverable.project_id;
    if (!projectId && deliverable.task_id) {
      const linkedTask = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(deliverable.task_id);
      projectId = linkedTask?.project_id || null;
    }
    if (projectId) {
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
      const agent = deliverable.agent_id
        ? db.prepare('SELECT id, name FROM agents WHERE id = ?').get(deliverable.agent_id)
        : null;

      const eventData = {
        project: project ? { id: project.id, name: project.name } : { id: projectId },
        deliverable: {
          id: updated.id,
          title: updated.title,
          summary: updated.summary,
          content: updated.content,
          content_type: updated.content_type,
          status: updated.status,
          files: safeJsonParse(updated.files, []),
          metadata: safeJsonParse(updated.metadata, {}),
          submitted_by: agent ? { id: agent.id, name: agent.name } : null,
          approved_by: { id: req.user.id, name: req.user.name || req.user.email },
          approved_at: updated.reviewed_at
        },
        feedback: feedback || null,
        timestamp: new Date().toISOString()
      };

      // Dispatch specific decision event (deliverable.approved, deliverable.revision_requested, deliverable.rejected)
      dispatchEvent(`deliverable.${decision}`, eventData)
        .catch(err => console.error('[Deliverables] Route dispatch error:', err));

      // Also dispatch generic review.completed event for catch-all routes
      dispatchEvent('review.completed', {
        ...eventData,
        decision
      }).catch(err => console.error('[Deliverables] Route dispatch error:', err));

      // Fire task.completed and task.status_changed events when approval completes a task
      if (decision === 'approved' && deliverable.task_id) {
        const completedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(deliverable.task_id);
        if (completedTask) {
          const taskPayload = {
            id: completedTask.id,
            title: completedTask.title,
            status: 'completed',
            priority: completedTask.priority
          };

          dispatchEvent('task.status_changed', {
            project: eventData.project,
            projectId,
            task: taskPayload,
            old_status: 'review',
            new_status: 'completed',
            timestamp: new Date().toISOString()
          }).catch(err => console.error('[Deliverables] Route dispatch error (task.status_changed):', err));

          dispatchEvent('task.completed', {
            project: eventData.project,
            projectId,
            task: taskPayload,
            timestamp: new Date().toISOString()
          }).catch(err => console.error('[Deliverables] Route dispatch error (task.completed):', err));
        }
      }
    }

    response.success(res, {
      ...updated,
      files: safeJsonParse(updated.files, []),
      actions: safeJsonParse(updated.actions, []),
      metadata: safeJsonParse(updated.metadata, {})
    });
  } catch (err) {
    console.error('Error reviewing deliverable:', err);
    response.serverError(res);
  }
});

// ============================================
// Agent endpoints (require agent authentication)
// ============================================

/**
 * POST /api/deliverables
 * Submit a deliverable (agent endpoint)
 * Supports task-linked or standalone deliverables with files and actions
 */
router.post('/', agentAuth, validateBody(submitDeliverableSchema), logAgentActivity('deliverable.submitted', (req, data) => ({
  type: 'deliverable',
  id: data?.data?.id,
  details: { taskId: req.body.taskId, projectId: req.body.projectId, title: req.body.title }
})), async (req, res) => {
  try {
    const { taskId, projectId, title, summary, content, contentType, files, actions, metadata, inputTokens, outputTokens, provider, model } = req.body;

    let task = null;
    let resolvedProjectId = null;
    let version = 1;
    let parentId = null;

    // If taskId provided, verify task exists and agent is assigned
    if (taskId) {
      task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!task) {
        return response.notFound(res, 'Task');
      }

      // Validate assignment based on key type
      if (req.agent.id) {
        // Agent key: must be assigned to this specific agent
        if (task.assigned_agent_id !== req.agent.id) {
          return response.forbidden(res, 'Task not assigned to this agent');
        }
      } else if (req.agent.isUserKey && task.assigned_agent_id) {
        // User key: check if task is assigned to an agent linked to this user
        const assignedAgent = db.prepare('SELECT owner_user_id FROM agents WHERE id = ?').get(task.assigned_agent_id);
        if (assignedAgent && assignedAgent.owner_user_id !== req.agent.userId) {
          return response.forbidden(res, 'Task not assigned to your agent');
        }
      }

      resolvedProjectId = task.project_id;

      // Get current version number for this task
      const lastVersion = db.prepare(`
        SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?
      `).get(taskId);
      version = (lastVersion?.max_version || 0) + 1;

      // Find parent deliverable if this is a revision
      if (version > 1) {
        const parent = db.prepare(`
          SELECT id FROM deliverables WHERE task_id = ? AND version = ?
        `).get(taskId, version - 1);
        parentId = parent?.id;
      }
    } else if (projectId) {
      // Standalone deliverable - resolve project
      let project;
      if (typeof projectId === 'number' || /^\d+$/.test(projectId)) {
        project = db.prepare('SELECT id FROM projects WHERE id = ?').get(parseInt(projectId));
      } else {
        project = db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE').get(projectId);
      }
      if (project) {
        resolvedProjectId = project.id;
      }
    }

    // Determine content to store
    let finalContent = content || '';
    let finalContentType = contentType || 'markdown';

    // Auto-detect HTML content without explicit contentType
    const trimmedContent = content ? content.trim() : '';
    const looksLikeHtml = trimmedContent.startsWith('<!DOCTYPE') ||
                          trimmedContent.startsWith('<html') ||
                          trimmedContent.startsWith('<head') ||
                          trimmedContent.startsWith('<body') ||
                          trimmedContent.startsWith('<!--') ||
                          /^<(div|section|article|header|footer|nav|main|aside|form|table|ul|ol|span|p|h[1-6])\b/i.test(trimmedContent);

    if (!contentType && content && looksLikeHtml) {
      finalContentType = 'html';
    }

    // Validate file sizes BEFORE inserting to prevent orphan rows
    if (files && files.length > 0) {
      let totalSize = 0;
      for (const file of files) {
        const fileSize = Buffer.byteLength(file.content, 'utf8');
        if (fileSize > MAX_FILE_SIZE) {
          return response.validationError(res, `File ${file.filename} exceeds maximum size of 10MB`);
        }
        totalSize += fileSize;
      }
      if (totalSize > MAX_TOTAL_FILES_SIZE) {
        return response.validationError(res, 'Total file size exceeds maximum of 50MB');
      }
    }

    // Determine submitted_by_user_id for user key submissions
    const submittedByUserId = req.agent.isUserKey ? req.agent.userId : null;

    // Insert deliverable with version retry (Issue #15: prevents duplicate versions)
    let deliverableId;
    try {
      const insertResult = insertDeliverableWithRetry(db, () => {
        // Re-read version inside transaction for atomicity
        let txVersion = version;
        let txParentId = parentId;
        if (taskId) {
          const lastVersion = db.prepare(`
            SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?
          `).get(taskId);
          txVersion = (lastVersion?.max_version || 0) + 1;
          if (txVersion > 1) {
            const parent = db.prepare(`
              SELECT id FROM deliverables WHERE task_id = ? AND version = ?
            `).get(taskId, txVersion - 1);
            txParentId = parent?.id || null;
          }
        }

        const result = db.prepare(`
          INSERT INTO deliverables (
            task_id, project_id, agent_id, submitted_by_user_id, title, summary, content, content_type,
            version, parent_id, files, actions, metadata,
            input_tokens, output_tokens, provider, model
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          taskId || null,
          resolvedProjectId,
          req.agent.id || null,
          submittedByUserId,
          title,
          summary || null,
          finalContent,
          finalContentType,
          txVersion,
          txParentId,
          '[]', // Placeholder for files, will update after saving
          JSON.stringify(actions || []),
          JSON.stringify(metadata || {}),
          inputTokens || null,
          outputTokens || null,
          provider || null,
          model || null
        );

        // Update task status to review (if task-linked)
        if (taskId) {
          db.prepare(`
            UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = ?
          `).run(taskId);
        }

        return result.lastInsertRowid;
      });
      deliverableId = insertResult;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({
          success: false,
          error: 'Concurrent version conflict after retries. Please retry submission.'
        });
      }
      throw err;
    }

    // Log activity (outside transaction — safe to fail independently)
    const submitActorName = req.agent.id
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(req.agent.id)?.name || 'agent')
      : 'user';
    logActivity('deliverable', Number(deliverableId), 'created', submitActorName, { title, source: submitActorName });

    // Save file attachments if provided (already validated above — async, outside transaction)
    let savedFiles = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const mimeType = file.mimeType || getMimeType(file.filename);
        const savedFile = await saveFile(file.filename, file.content, deliverableId);
        savedFiles.push({
          ...savedFile,
          mimeType
        });
      }

      // Update deliverable with file references
      db.prepare(`
        UPDATE deliverables SET files = ?, updated_at = datetime('now') WHERE id = ?
      `).run(JSON.stringify(savedFiles), deliverableId);
    }

    const deliverable = db.prepare('SELECT * FROM deliverables WHERE id = ?').get(deliverableId);

    // Dispatch to delivery routes
    if (resolvedProjectId) {
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(resolvedProjectId);
      const agentInfo = req.agent.id
        ? db.prepare('SELECT id, name FROM agents WHERE id = ?').get(req.agent.id)
        : null;

      dispatchEvent('deliverable.submitted', {
        project: project ? { id: project.id, name: project.name } : { id: resolvedProjectId },
        deliverable: {
          id: deliverable.id,
          title: deliverable.title,
          summary: deliverable.summary,
          content: deliverable.content,
          content_type: deliverable.content_type,
          status: deliverable.status,
          files: savedFiles,
          metadata: safeJsonParse(deliverable.metadata, {}),
          submitted_by: agentInfo ? { id: agentInfo.id, name: agentInfo.name } : null
        },
        taskId: taskId || null,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Deliverables] Route dispatch error:', err));
    }

    response.created(res, {
      ...deliverable,
      files: safeJsonParse(deliverable.files, []),
      actions: safeJsonParse(deliverable.actions, []),
      metadata: safeJsonParse(deliverable.metadata, {})
    });
  } catch (err) {
    console.error('Error submitting deliverable:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/deliverables/:id/revision
 * Submit a revision (agent endpoint)
 */
router.post('/:id/revision', agentAuth, validateBody(submitRevisionSchema), logAgentActivity('deliverable.revision_submitted', (req, data) => ({
  type: 'deliverable',
  id: data?.data?.id,
  details: { parentId: parseInt(req.params.id) }
})), async (req, res) => {
  try {
    // Get the parent deliverable
    const parent = db.prepare(`
      SELECT d.*, t.assigned_agent_id
      FROM deliverables d
      JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ?
    `).get(req.params.id);

    if (!parent) {
      return response.notFound(res, 'Deliverable');
    }

    // Verify this agent owns the deliverable
    // req.agent.id is null for user keys, so check that first
    if (req.agent.id && parent.agent_id !== req.agent.id) {
      return response.forbidden(res, 'Deliverable not created by this agent');
    }
    // For user keys, verify they're admin (since no agent_id to match)
    if (!req.agent.id && req.agent.isUserKey && req.agent.userRole !== 'admin') {
      return response.forbidden(res, 'Admin access required');
    }

    // Verify the deliverable needs revision
    if (parent.status !== 'revision_requested') {
      return response.validationError(res, 'Deliverable does not require revision');
    }

    const { title, summary, content, contentType, metadata, files, actions } = req.body;

    // Validate file sizes BEFORE inserting to prevent orphan rows
    if (files && files.length > 0) {
      let totalSize = 0;
      for (const file of files) {
        const fileSize = Buffer.byteLength(file.content, 'utf8');
        if (fileSize > MAX_FILE_SIZE) {
          return response.validationError(res, `File ${file.filename} exceeds maximum size of 10MB`);
        }
        totalSize += fileSize;
      }
      if (totalSize > MAX_TOTAL_FILES_SIZE) {
        return response.validationError(res, 'Total file size exceeds maximum of 50MB');
      }
    }

    // Determine final content (use provided or keep parent's if files-only revision)
    const finalContent = content ?? parent.content ?? '';
    const finalSummary = summary ?? parent.summary;
    const finalActions = actions ?? safeJsonParse(parent.actions, []);

    // Determine submitted_by_user_id for user key submissions
    const submittedByUserId = req.agent.isUserKey ? req.agent.userId : null;

    // Insert revision with version retry (Issue #15: use MAX(version) instead of parent.version + 1)
    let deliverableId;
    try {
      const insertResult = insertDeliverableWithRetry(db, () => {
        // Re-read max version inside transaction for atomicity
        const lastVersion = db.prepare(`
          SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?
        `).get(parent.task_id);
        const txVersion = (lastVersion?.max_version || 0) + 1;

        const result = db.prepare(`
          INSERT INTO deliverables (
            task_id, agent_id, submitted_by_user_id, title, summary, content, content_type, version, parent_id, files, actions, metadata
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          parent.task_id,
          req.agent.id,
          submittedByUserId,
          title || parent.title,
          finalSummary,
          finalContent,
          contentType || parent.content_type,
          txVersion,
          parent.id,
          '[]', // Placeholder for files, will update after saving
          JSON.stringify(finalActions),
          JSON.stringify(metadata || safeJsonParse(parent.metadata, {}))
        );

        // Update parent deliverable status to 'revised'
        db.prepare(`
          UPDATE deliverables SET status = 'revised', updated_at = datetime('now') WHERE id = ?
        `).run(parent.id);

        return result.lastInsertRowid;
      });
      deliverableId = insertResult;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({
          success: false,
          error: 'Concurrent version conflict after retries. Please retry submission.'
        });
      }
      throw err;
    }

    // Log activity (outside transaction)
    const revisionActorName = req.agent.id
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(req.agent.id)?.name || 'agent')
      : 'user';
    logActivity('deliverable', Number(deliverableId), 'created', revisionActorName, { title: title || parent.title, source: revisionActorName, revision_of: parent.id });

    // Save file attachments if provided (already validated above)
    let savedFiles = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const mimeType = file.mimeType || getMimeType(file.filename);
        const savedFile = await saveFile(file.filename, file.content, deliverableId);
        savedFiles.push({
          ...savedFile,
          mimeType
        });
      }

      // Update deliverable with file references
      db.prepare(`
        UPDATE deliverables SET files = ?, updated_at = datetime('now') WHERE id = ?
      `).run(JSON.stringify(savedFiles), deliverableId);
    }

    const deliverable = db.prepare('SELECT * FROM deliverables WHERE id = ?').get(deliverableId);

    // Dispatch deliverable.submitted event for delivery routes
    if (parent.project_id) {
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(parent.project_id);
      const agentName = req.agent.id
        ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(req.agent.id)?.name || 'agent')
        : 'user';
      dispatchEvent('deliverable.submitted', {
        project: project ? { id: project.id, name: project.name } : { id: parent.project_id },
        projectId: parent.project_id,
        deliverable: {
          id: deliverableId,
          title: deliverable.title,
          content: deliverable.content,
          content_type: deliverable.content_type,
          status: deliverable.status,
          version: deliverable.version,
          parent_id: parent.id,
          submitted_by: agentName
        },
        taskId: parent.task_id,
        isRevision: true,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Deliverables] Route dispatch error:', err));
    }

    response.created(res, {
      ...deliverable,
      files: safeJsonParse(deliverable.files, []),
      metadata: safeJsonParse(deliverable.metadata, {})
    });
  } catch (err) {
    console.error('Error submitting revision:', err);
    response.serverError(res);
  }
});

// ============================================
// Activity log endpoint
// ============================================

/**
 * GET /api/deliverables/:id/activity
 * Get activity log for a deliverable
 */
router.get('/:id/activity', dualAuth, (req, res) => {
  try {
    // Authorization check
    const access = canAccessDeliverable(req, req.params.id);
    if (!access.allowed) {
      return access.reason === 'not_found'
        ? response.notFound(res, 'Deliverable')
        : response.forbidden(res, 'Access denied');
    }

    const deliverable = db.prepare('SELECT id FROM deliverables WHERE id = ?').get(req.params.id);
    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    const activities = db.prepare(`
      SELECT id, event_type, actor_name, detail, created_at
      FROM activity_log
      WHERE entity_type = 'deliverable' AND entity_id = ?
      ORDER BY created_at DESC
    `).all(req.params.id);

    const parsed = activities.map(a => ({
      ...a,
      detail: safeJsonParse(a.detail, {}),
      created_at: toISOTimestamp(a.created_at)
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error fetching deliverable activity:', err);
    response.serverError(res);
  }
});

export default router;
