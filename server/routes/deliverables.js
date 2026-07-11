import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db/adapter.js';
import * as response from '../utils/response.js';
import { requireUserOrUserKeyRoles } from '../middleware/userAuth.js';
import { agentAuth, dualAuth, logAgentActivity } from '../middleware/agentAuth.js';
import { triggerWebhook } from '../services/webhooks.js';
import { dispatchEvent } from '../services/routeDispatcher.js';
import { logActivity } from '../services/activityLogger.js';
import { canAccessDeliverable, requireActorAccess } from '../utils/authorization.js';
import {
  validateBody,
  submitDeliverableSchema,
  submitRevisionSchema,
  reviewDeliverableSchema
} from '../utils/validation.js';
import { insertDeliverableWithRetry } from '../utils/deliverableVersioning.js';
import { detectDeliverableContentType } from '../utils/detectDeliverableContentType.js';
import { toISOTimestamp as formatTimestamp } from '../utils/routeHelpers.js';
import {
  getMimeType,
  sanitizeFilename,
  saveDeliverableFile,
  ensureUploadsDir,
  validateFileAttachments
} from '../utils/deliverableFiles.js';

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

function buildDeliverableHtmlFilename(title) {
  const base = String(title || 'deliverable')
    .toLowerCase()
    .replace(/^deliverable:\s*/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${base || 'deliverable'}.html`;
}

function shouldCreateHtmlAttachment(savedFiles, contentType, content) {
  if (Array.isArray(savedFiles) && savedFiles.length > 0) return false;
  if (String(contentType || '').trim().toLowerCase() !== 'html') return false;
  return typeof content === 'string' && content.trim().length > 0;
}

/**
 * Convert SQLite timestamp to ISO 8601 format with explicit UTC marker.
 * SQLite stores timestamps like "2026-02-11 16:36:31" (UTC but no Z suffix).
 * JavaScript needs the Z suffix to correctly interpret as UTC.
 * @param {string} timestamp - SQLite timestamp string
 * @returns {string|null} ISO 8601 timestamp with Z suffix, or null
 */
function toISOTimestamp(timestamp) {
  return formatTimestamp(timestamp);
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

function parseTaskContext(rawContext) {
  if (!rawContext) return {};
  if (typeof rawContext === 'object') return rawContext;
  if (typeof rawContext === 'string') {
    try {
      const parsed = JSON.parse(rawContext);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function appendRevisionContext(baseContext, feedback, source, requestedBy) {
  const next = parseTaskContext(baseContext);
  const text = String(feedback || '').trim();
  if (!text) return next;

  const entry = {
    feedback: text,
    source: String(source || 'deliverable_review'),
    requested_at: new Date().toISOString(),
  };
  if (requestedBy) entry.requested_by = requestedBy;

  const existing = Array.isArray(next.revision_requests) ? next.revision_requests : [];
  next.revision_requests = [...existing, entry].slice(-20);
  next.latest_revision_request = entry;
  next.latest_revision_feedback = text;
  return next;
}

function getReviewerActor(req) {
  const id = req.user?.id || req.agent?.userId || null;
  const email = req.user?.email || req.agent?.userEmail || null;
  const name = req.user?.name || req.agent?.userName || email || (id ? `user:${id}` : 'reviewer');
  return {
    id,
    email,
    name,
    reviewedBy: email || name || (id ? `user:${id}` : 'reviewer')
  };
}

function applyTaskContextPlan(rawContext) {
  return rawContext && typeof rawContext === 'object' ? rawContext : {};
}

function getSubmissionClientLabel(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  return String(
    metadata.submission_client_label
    ?? metadata.submissionClientLabel
    ?? metadata.key_name
    ?? metadata.keyName
    ?? ''
  ).trim();
}

function withUserKeySubmissionMetadata(metadata, agentActor) {
  const next = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
    ? { ...metadata }
    : {};
  if (!agentActor?.isUserKey) return next;
  const clientLabel = String(agentActor.keyName || '').trim();
  next.submitted_via = next.submitted_via || 'user_api_key';
  if (clientLabel) {
    next.submission_client_label = clientLabel;
  }
  return next;
}

function buildDeliverableActorLabel(row, metadata) {
  const baseName = String(row?.agent_name || '').trim();
  const clientLabel = getSubmissionClientLabel(metadata);
  const hasResolvedAgent = Boolean(row?.resolved_agent_id ?? row?.agent_id);
  const hasSubmittingUser = Boolean(row?.submitted_by_user_id);
  if (!hasResolvedAgent && hasSubmittingUser && baseName && clientLabel) {
    return `${baseName} via ${clientLabel}`;
  }
  return baseName;
}

function extractHostedMcpReviewSource(req) {
  const source = String(req?.headers?.['x-cavendo-mcp-source'] || '').trim();
  const client = String(req?.headers?.['x-cavendo-mcp-client'] || '').trim();
  if (!source && !client) return null;
  return {
    review_source: source || null,
    review_source_client: client || null,
    review_source_label: client ? `via ${client}` : 'via hosted MCP',
  };
}

async function persistTaskRevisionContext(taskId, feedback, source, requestedBy) {
  const revisionFeedback = String(feedback || '').trim();
  if (!taskId || !revisionFeedback) return;

  const task = await db.one('SELECT id, title, description, project_id, tags, context FROM tasks WHERE id = ?', [taskId]);
  if (!task) return;

  const nextContext = appendRevisionContext(task.context, revisionFeedback, source, requestedBy);
  const normalizedContext = applyTaskContextPlan(nextContext, {
    title: task.title || `Task ${taskId}`,
    description: task.description || null,
    project_id: task.project_id || null,
    tags: safeJsonParse(task.tags, []),
  });
  await db.exec(`
    UPDATE tasks
    SET context = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [JSON.stringify(normalizedContext), taskId]);
}

async function maybeSendInboundTaskCompletionUpdate({ taskId, deliverable, reviewerUserId }) {
  return null;
}

async function maybeSendInboundTaskReviewReadyUpdate({ taskId, deliverable, submitterUserId }) {
  return null;
}

// Ensure uploads directory exists
ensureUploadsDir().catch(console.error);

// ============================================
// Admin endpoints (require user authentication)
// ============================================

/**
 * GET /api/deliverables
 * List all deliverables with filtering
 * Supports browser sessions and API keys.
 */
router.get('/', dualAuth, requireActorAccess(), async (req, res) => {
  try {
    const { status, taskId, agentId, projectId } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = `
      SELECT
        d.*,
        t.title as task_title,
        COALESCE(d.project_id, t.project_id) as resolved_project_id,
        COALESCE(p1.name, p2.name) as project_name,
        COALESCE(d.agent_id, t.assigned_agent_id) as resolved_agent_id,
        COALESCE(a.name, ta.name, u.name, u.email) as agent_name
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      LEFT JOIN projects p1 ON p1.id = d.project_id
      LEFT JOIN projects p2 ON p2.id = t.project_id
      LEFT JOIN agents a ON a.id = d.agent_id
      LEFT JOIN agents ta ON ta.id = t.assigned_agent_id
      LEFT JOIN users u ON u.id = d.submitted_by_user_id
      WHERE 1=1
    `;
    const params = [];

    if (req.agent && !req.agent.isUserKey) {
      if (agentId && Number.parseInt(agentId, 10) !== Number(req.agent.id)) {
        return response.success(res, []);
      }
      query += ' AND (d.agent_id = ? OR t.assigned_agent_id = ?)';
      params.push(req.agent.id, req.agent.id);
    }

    if (status) {
      query += ' AND d.status = ?';
      params.push(status);
    }
    if (taskId) {
      query += ' AND d.task_id = ?';
      params.push(parseInt(taskId));
    }
    if (agentId && !(req.agent && !req.agent.isUserKey)) {
      query += ' AND COALESCE(d.agent_id, t.assigned_agent_id) = ?';
      params.push(parseInt(agentId));
    }
    if (projectId) {
      query += ' AND (d.project_id = ? OR d.task_id IN (SELECT id FROM tasks WHERE project_id = ?))';
      params.push(parseInt(projectId), parseInt(projectId));
    }

    query += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const deliverables = await db.many(query, params);

    const parsed = deliverables.map((d) => {
      const metadata = safeJsonParse(d.metadata, {});
      return {
        ...normalizeTimestamps(d),
        agent_id: d.resolved_agent_id,
        agent_name: buildDeliverableActorLabel(d, metadata),
        project_id: d.resolved_project_id,
        files: safeJsonParse(d.files, []),
        actions: safeJsonParse(d.actions, []),
        metadata,
      };
    });

    response.success(res, parsed);
  } catch (err) {
    console.error('Error listing deliverables:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/deliverables/pending
 * List deliverables pending review
 * Supports browser sessions and API keys.
 */
router.get('/pending', dualAuth, requireActorAccess(), async (req, res) => {
  try {
    let query = `
      SELECT
        d.*,
        t.title as task_title,
        COALESCE(d.project_id, t.project_id) as resolved_project_id,
        COALESCE(p1.name, p2.name) as project_name,
        COALESCE(d.agent_id, t.assigned_agent_id) as resolved_agent_id,
        COALESCE(a.name, ta.name, u.name, u.email) as agent_name
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      LEFT JOIN projects p1 ON p1.id = d.project_id
      LEFT JOIN projects p2 ON p2.id = t.project_id
      LEFT JOIN agents a ON a.id = d.agent_id
      LEFT JOIN agents ta ON ta.id = t.assigned_agent_id
      LEFT JOIN users u ON u.id = d.submitted_by_user_id
      WHERE d.status = 'pending'
    `;
    const params = [];

    if (req.agent && !req.agent.isUserKey) {
      query += ' AND (d.agent_id = ? OR t.assigned_agent_id = ?)';
      params.push(req.agent.id, req.agent.id);
    }

    query += ' ORDER BY d.created_at ASC';

    const deliverables = await db.many(query, params);

    const parsed = deliverables.map((d) => {
      const metadata = safeJsonParse(d.metadata, {});
      return {
        ...normalizeTimestamps(d),
        agent_id: d.resolved_agent_id,
        agent_name: buildDeliverableActorLabel(d, metadata),
        project_id: d.resolved_project_id,
        files: safeJsonParse(d.files, []),
        actions: safeJsonParse(d.actions, []),
        metadata,
      };
    });

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
router.get('/mine', agentAuth, requireActorAccess(), async (req, res) => {
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
          COALESCE(a.name, ta.name, u.name, u.email) as agent_name
        FROM deliverables d
        LEFT JOIN tasks t ON t.id = d.task_id
        LEFT JOIN projects p1 ON p1.id = d.project_id
        LEFT JOIN projects p2 ON p2.id = t.project_id
        LEFT JOIN agents a ON a.id = d.agent_id
        LEFT JOIN agents ta ON ta.id = t.assigned_agent_id
        LEFT JOIN users u ON u.id = d.submitted_by_user_id
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

    const deliverables = await db.many(query, params);

    const parsed = deliverables.map((d) => {
      const metadata = safeJsonParse(d.metadata, {});
      return {
        ...normalizeTimestamps(d),
        agent_name: buildDeliverableActorLabel(d, metadata),
        files: safeJsonParse(d.files, []),
        actions: safeJsonParse(d.actions, []),
        metadata,
      };
    });

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
router.get('/:id', dualAuth, requireActorAccess(), async (req, res) => {
  try {
    // Authorization check
    const access = await canAccessDeliverable(req, req.params.id);
    if (!access.allowed) {
      return access.reason === 'not_found'
        ? response.notFound(res, 'Deliverable')
        : response.forbidden(res, 'Access denied');
    }

    const deliverable = await db.one(`
      SELECT
        d.*,
        t.title as task_title,
        t.description as task_description,
        COALESCE(d.project_id, t.project_id) as resolved_project_id,
        COALESCE(p1.name, p2.name) as project_name,
        COALESCE(a.name, ta.name, u.name, u.email) as agent_name
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      LEFT JOIN projects p1 ON p1.id = d.project_id
      LEFT JOIN projects p2 ON p2.id = t.project_id
      LEFT JOIN agents a ON a.id = d.agent_id
      LEFT JOIN agents ta ON ta.id = t.assigned_agent_id
      LEFT JOIN users u ON u.id = d.submitted_by_user_id
      WHERE d.id = ?
    `, [req.params.id]);

    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    // Get version history (for task-linked deliverables)
    let versions = [];
    if (deliverable.task_id) {
      const rawVersions = await db.many(`
        SELECT
          d.id,
          d.version,
          d.status,
          d.title,
          d.summary,
          d.content,
          d.input_tokens,
          d.output_tokens,
          d.provider,
          d.model,
          d.content_type,
          d.feedback,
          d.reviewed_by,
          d.parent_id,
          d.submitted_by_user_id,
          d.files,
          d.metadata,
          d.created_at,
          d.updated_at,
          d.reviewed_at,
          COALESCE(a.name, ta.name, u.name, u.email) as agent_name
        FROM deliverables d
        LEFT JOIN agents a ON a.id = d.agent_id
        LEFT JOIN tasks t ON t.id = d.task_id
        LEFT JOIN agents ta ON ta.id = t.assigned_agent_id
        LEFT JOIN users u ON u.id = d.submitted_by_user_id
        WHERE task_id = ?
        ORDER BY d.version DESC
      `, [deliverable.task_id]);
      versions = rawVersions.map((v) => {
        const metadata = safeJsonParse(v.metadata, {});
        return {
          ...v,
          agent_name: buildDeliverableActorLabel(v, metadata),
          files: safeJsonParse(v.files, []),
          metadata,
          created_at: toISOTimestamp(v.created_at),
          updated_at: toISOTimestamp(v.updated_at),
          reviewed_at: toISOTimestamp(v.reviewed_at)
        };
      });
    }

    response.success(res, {
      ...normalizeTimestamps(deliverable),
      agent_name: buildDeliverableActorLabel(deliverable, safeJsonParse(deliverable.metadata, {})),
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
router.get('/:id/feedback', dualAuth, requireActorAccess(), async (req, res) => {
  try {
    const deliverable = await db.one(`
      SELECT id, task_id, agent_id, status, feedback, reviewed_by, reviewed_at
      FROM deliverables
      WHERE id = ?
    `, [req.params.id]);

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
router.patch('/:id/review', dualAuth, requireUserOrUserKeyRoles('admin', 'reviewer'), validateBody(reviewDeliverableSchema), async (req, res) => {
  try {
    const deliverable = await db.one(`
      SELECT d.*, t.assigned_agent_id
      FROM deliverables d
      LEFT JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ?
    `, [req.params.id]);

    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    if (deliverable.status !== 'pending') {
      return response.validationError(res, 'Deliverable has already been reviewed');
    }

    const { decision, feedback } = req.body;
    const reviewer = getReviewerActor(req);

    const reviewSourceMetadata = extractHostedMcpReviewSource(req);
    const mergedMetadata = {
      ...safeJsonParse(deliverable.metadata, {}),
      ...(reviewSourceMetadata || {}),
    };

    await db.exec(`
      UPDATE deliverables
      SET status = ?, feedback = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now'), metadata = ?
      WHERE id = ?
    `, [decision, feedback || null, reviewer.reviewedBy, JSON.stringify(mergedMetadata), req.params.id]);

    // Log activity
    logActivity('deliverable', parseInt(req.params.id), 'status_changed', reviewer.name, { from: 'pending', to: decision });
    if (decision === 'revision_requested' && feedback) {
      logActivity('deliverable', parseInt(req.params.id), 'revision_requested', reviewer.name, { feedback: feedback.substring(0, 200) });
    }

    // Update task status based on review decision
    if (deliverable.task_id) {
      if (decision === 'approved') {
        await db.exec(`
          UPDATE tasks
          SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `, [deliverable.task_id]);

        // Log task completion in activity trail
        logActivity('task', deliverable.task_id, 'completed', reviewer.name, {
          completedVia: 'deliverable_approval',
          deliverableId: parseInt(req.params.id)
        });
      } else if (decision === 'revision_requested') {
        // Reset task to assigned so agent/dispatcher can re-execute
        await db.exec(`
          UPDATE tasks
          SET status = 'assigned', updated_at = datetime('now')
          WHERE id = ?
        `, [deliverable.task_id]);
        await persistTaskRevisionContext(
          deliverable.task_id,
          feedback || '',
          'deliverable_review',
          reviewer.email || reviewer.id || null
        );
      } else if (decision === 'rejected') {
        await db.exec(`
          UPDATE tasks
          SET status = 'cancelled', updated_at = datetime('now')
          WHERE id = ? AND status IN ('pending', 'assigned', 'in_progress', 'review')
        `, [deliverable.task_id]);

        logActivity('task', deliverable.task_id, 'cancelled', reviewer.name, {
          cancelledVia: 'deliverable_rejection',
          deliverableId: parseInt(req.params.id, 10)
        });
      }
    }

    const updated = await db.one('SELECT * FROM deliverables WHERE id = ?', [req.params.id]);

    if (decision === 'approved') {
      if (deliverable.task_id) {
        await maybeSendInboundTaskCompletionUpdate({
          taskId: deliverable.task_id,
          deliverable: updated,
          reviewerUserId: reviewer.id,
        });
      }
    }

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
      const linkedTask = await db.one('SELECT project_id FROM tasks WHERE id = ?', [deliverable.task_id]);
      projectId = linkedTask?.project_id || null;
    }
    if (projectId) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [projectId]);
      const agent = deliverable.agent_id
        ? await db.one('SELECT id, name FROM agents WHERE id = ?', [deliverable.agent_id])
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
          approved_by: { id: reviewer.id, name: reviewer.name },
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
        const completedTask = await db.one('SELECT * FROM tasks WHERE id = ?', [deliverable.task_id]);
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
router.post('/', agentAuth, requireActorAccess({ roles: ['admin', 'operator', 'reviewer'], agentScope: 'write' }), validateBody(submitDeliverableSchema), logAgentActivity('deliverable.submitted', (req, data) => ({
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
      task = await db.one('SELECT * FROM tasks WHERE id = ?', [taskId]);
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
        // Admin user keys can submit on any task. Other user keys are limited
        // to tasks assigned to agents they own.
        if (req.agent.userRole !== 'admin') {
          const assignedAgent = await db.one('SELECT owner_user_id FROM agents WHERE id = ?', [task.assigned_agent_id]);
          if (assignedAgent && assignedAgent.owner_user_id !== req.agent.userId) {
            return response.forbidden(res, 'Task not assigned to your agent');
          }
        }
      }

      resolvedProjectId = task.project_id;

      // Get current version number for this task
      const lastVersion = await db.one(`
        SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?
      `, [taskId]);
      version = (lastVersion?.max_version || 0) + 1;

      // Find parent deliverable if this is a revision
      if (version > 1) {
        const parent = await db.one(`
          SELECT id FROM deliverables WHERE task_id = ? AND version = ?
        `, [taskId, version - 1]);
        parentId = parent?.id;
      }
    } else if (projectId) {
      // Standalone deliverable - resolve project
      let project;
      if (typeof projectId === 'number' || /^\d+$/.test(projectId)) {
        project = await db.one('SELECT id FROM projects WHERE id = ?', [parseInt(projectId)]);
      } else {
        project = await db.one('SELECT id FROM projects WHERE LOWER(name) = LOWER(?)', [projectId]);
      }
      if (project) {
        resolvedProjectId = project.id;
      }
    }

    // Determine content to store
    let finalContent = content || '';
    let finalContentType = contentType || detectDeliverableContentType(content);

    // Validate file sizes BEFORE inserting to prevent orphan rows
    if (files && files.length > 0) {
      const filePolicy = validateFileAttachments(files);
      if (!filePolicy.valid) {
        return response.validationError(res, filePolicy.errors.join('; '));
      }
    }

    const finalMetadata = withUserKeySubmissionMetadata(metadata, req.agent);

    // Determine submitted_by_user_id for user key submissions
    const submittedByUserId = req.agent.isUserKey ? req.agent.userId : null;

    // Insert deliverable with version retry (Issue #15: prevents duplicate versions)
    let deliverableId;
    try {
      const insertResult = await insertDeliverableWithRetry(db, async (tx) => {
        // Re-read version inside transaction for atomicity
        let txVersion = version;
        let txParentId = parentId;
        if (taskId) {
          const lastVersion = await tx.one(`
            SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?
          `, [taskId]);
          txVersion = (lastVersion?.max_version || 0) + 1;
          if (txVersion > 1) {
            const parent = await tx.one(`
              SELECT id FROM deliverables WHERE task_id = ? AND version = ?
            `, [taskId, txVersion - 1]);
            txParentId = parent?.id || null;
          }
        }

        const result = await tx.insert(`
          INSERT INTO deliverables (
            task_id, project_id, agent_id, submitted_by_user_id, title, summary, content, content_type,
            version, parent_id, files, actions, metadata,
            input_tokens, output_tokens, provider, model
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
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
          JSON.stringify(finalMetadata),
          inputTokens || null,
          outputTokens || null,
          provider || null,
          model || null
        ]);

        // Update task status to review (if task-linked)
        if (taskId) {
          await tx.exec(`
            UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = ?
          `, [taskId]);
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
      ? ((await db.one('SELECT name FROM agents WHERE id = ?', [req.agent.id]))?.name || 'agent')
      : 'user';
    logActivity('deliverable', Number(deliverableId), 'created', submitActorName, { title, source: submitActorName });

    // Save file attachments if provided (already validated above — async, outside transaction)
    let savedFiles = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const mimeType = file.mimeType || getMimeType(file.filename);
        const savedFile = await saveDeliverableFile(file.filename, file.content, deliverableId);
        savedFiles.push({
          ...savedFile,
          mimeType
        });
      }

      // Update deliverable with file references
      await db.exec(`
        UPDATE deliverables SET files = ?, updated_at = datetime('now') WHERE id = ?
      `, [JSON.stringify(savedFiles), deliverableId]);
    }

    // Ensure plain HTML responses still produce a downloadable file artifact.
    if (shouldCreateHtmlAttachment(savedFiles, finalContentType, finalContent)) {
      const savedHtml = await saveDeliverableFile(
        buildDeliverableHtmlFilename(title),
        finalContent,
        deliverableId
      );
      savedFiles = [{
        ...savedHtml,
        mimeType: 'text/html'
      }];
      await db.exec(`
        UPDATE deliverables SET files = ?, updated_at = datetime('now') WHERE id = ?
      `, [JSON.stringify(savedFiles), deliverableId]);
    }

    const deliverable = await db.one('SELECT * FROM deliverables WHERE id = ?', [deliverableId]);

    if (taskId) {
      await maybeSendInboundTaskReviewReadyUpdate({
        taskId,
        deliverable,
        submitterUserId: req.agent.isUserKey ? req.agent.userId : null,
      });
    }

    // Dispatch to delivery routes
    if (resolvedProjectId) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [resolvedProjectId]);
      const agentInfo = req.agent.id
        ? await db.one('SELECT id, name FROM agents WHERE id = ?', [req.agent.id])
        : null;
      const submitterLabel = req.agent.isUserKey
        ? [
          req.agent.userName || req.agent.userEmail || 'User',
          req.agent.keyName ? `via ${req.agent.keyName}` : null
        ].filter(Boolean).join(' ')
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
          submitted_by: agentInfo
            ? { id: agentInfo.id, name: agentInfo.name, type: 'agent' }
            : (submittedByUserId ? { id: submittedByUserId, name: submitterLabel || req.agent.userName || req.agent.userEmail || 'User', type: 'user_key' } : null)
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
router.post('/:id/revision', agentAuth, requireActorAccess({ roles: ['admin', 'operator', 'reviewer'], agentScope: 'write' }), validateBody(submitRevisionSchema), logAgentActivity('deliverable.revision_submitted', (req, data) => ({
  type: 'deliverable',
  id: data?.data?.id,
  details: { parentId: parseInt(req.params.id) }
})), async (req, res) => {
  try {
    // Get the parent deliverable
    const parent = await db.one(`
      SELECT d.*, t.assigned_agent_id
      FROM deliverables d
      JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ?
    `, [req.params.id]);

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
      const filePolicy = validateFileAttachments(files);
      if (!filePolicy.valid) {
        return response.validationError(res, filePolicy.errors.join('; '));
      }
    }

    // Determine final content (use provided or keep parent's if files-only revision)
    const finalContent = content ?? parent.content ?? '';
    const finalSummary = summary ?? parent.summary;
    const finalActions = actions ?? safeJsonParse(parent.actions, []);
    const finalContentType = contentType
      || (content ? detectDeliverableContentType(content) : parent.content_type)
      || detectDeliverableContentType(finalContent);

    const finalMetadata = withUserKeySubmissionMetadata(
      metadata ?? safeJsonParse(parent.metadata, {}),
      req.agent
    );

    // Determine submitted_by_user_id for user key submissions
    const submittedByUserId = req.agent.isUserKey ? req.agent.userId : null;

    // Insert revision with version retry (Issue #15: use MAX(version) instead of parent.version + 1)
    let deliverableId;
    try {
      const insertResult = await insertDeliverableWithRetry(db, async (tx) => {
        // Re-read max version inside transaction for atomicity
        const lastVersion = await tx.one(`
          SELECT MAX(version) as max_version FROM deliverables WHERE task_id = ?
        `, [parent.task_id]);
        const txVersion = (lastVersion?.max_version || 0) + 1;

        const result = await tx.insert(`
          INSERT INTO deliverables (
            task_id, agent_id, submitted_by_user_id, title, summary, content, content_type, version, parent_id, files, actions, metadata
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          parent.task_id,
          req.agent.id,
          submittedByUserId,
          title || parent.title,
          finalSummary,
          finalContent,
          finalContentType,
          txVersion,
          parent.id,
          '[]', // Placeholder for files, will update after saving
          JSON.stringify(finalActions),
          JSON.stringify(finalMetadata)
        ]);

        // Update parent deliverable status to 'revised'
        await tx.exec(`
          UPDATE deliverables SET status = 'revised', updated_at = datetime('now') WHERE id = ?
        `, [parent.id]);

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
      ? ((await db.one('SELECT name FROM agents WHERE id = ?', [req.agent.id]))?.name || 'agent')
      : 'user';
    logActivity('deliverable', Number(deliverableId), 'created', revisionActorName, { title: title || parent.title, source: revisionActorName, revision_of: parent.id });

    // Save file attachments if provided (already validated above)
    let savedFiles = [];
    if (files && files.length > 0) {
      for (const file of files) {
        const mimeType = file.mimeType || getMimeType(file.filename);
        const savedFile = await saveDeliverableFile(file.filename, file.content, deliverableId);
        savedFiles.push({
          ...savedFile,
          mimeType
        });
      }

      // Update deliverable with file references
      await db.exec(`
        UPDATE deliverables SET files = ?, updated_at = datetime('now') WHERE id = ?
      `, [JSON.stringify(savedFiles), deliverableId]);
    }

    if (shouldCreateHtmlAttachment(savedFiles, finalContentType, finalContent)) {
      const savedHtml = await saveDeliverableFile(
        buildDeliverableHtmlFilename(title || parent.title),
        finalContent,
        deliverableId
      );
      savedFiles = [{
        ...savedHtml,
        mimeType: 'text/html'
      }];
      await db.exec(`
        UPDATE deliverables SET files = ?, updated_at = datetime('now') WHERE id = ?
      `, [JSON.stringify(savedFiles), deliverableId]);
    }

    const deliverable = await db.one('SELECT * FROM deliverables WHERE id = ?', [deliverableId]);

    // Dispatch deliverable.submitted event for delivery routes
    if (parent.project_id) {
      const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [parent.project_id]);
      const agentName = req.agent.id
        ? ((await db.one('SELECT name FROM agents WHERE id = ?', [req.agent.id]))?.name || 'agent')
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
router.get('/:id/activity', dualAuth, requireActorAccess(), async (req, res) => {
  try {
    // Authorization check
    const access = await canAccessDeliverable(req, req.params.id);
    if (!access.allowed) {
      return access.reason === 'not_found'
        ? response.notFound(res, 'Deliverable')
        : response.forbidden(res, 'Access denied');
    }

    const deliverable = await db.one('SELECT id FROM deliverables WHERE id = ?', [req.params.id]);
    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    const activities = await db.many(`
      SELECT id, event_type, actor_name, detail, created_at
      FROM activity_log
      WHERE entity_type = 'deliverable' AND entity_id = ?
      ORDER BY created_at DESC
    `, [req.params.id]);

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
