import { Router } from 'express';
import db from '../db/adapter.js';
import * as response from '../utils/response.js';
import { dualAuth } from '../middleware/agentAuth.js';
import { canAccessTask, canAccessDeliverable } from '../utils/authorization.js';

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
 * Format comment for API response
 */
function formatComment(comment) {
  return {
    id: comment.id,
    content: comment.content,
    authorType: comment.author_type,
    authorId: comment.author_id,
    authorName: comment.author_name,
    createdAt: toISOTimestamp(comment.created_at),
    updatedAt: toISOTimestamp(comment.updated_at)
  };
}

/**
 * Get author info from request (handles both user and agent auth)
 */
function getAuthorInfo(req) {
  if (req.agent) {
    // Agent authentication (X-Agent-Key header)
    if (req.agent.isUserKey) {
      // User key - author is the user
      return {
        authorType: 'user',
        authorId: req.agent.userId,
        authorName: req.agent.userName || req.agent.userEmail
      };
    } else {
      // Agent key - author is the agent
      return {
        authorType: 'agent',
        authorId: req.agent.id,
        authorName: req.agent.name
      };
    }
  } else if (req.user) {
    // User session authentication (cookie)
    return {
      authorType: 'user',
      authorId: req.user.id,
      authorName: req.user.name || req.user.email
    };
  }
  return null;
}

/**
 * Check if current user can delete a comment
 */
function canDeleteComment(req, comment) {
  if (req.user && req.user.role === 'admin') {
    // Admins can delete any comment
    return true;
  }

  const author = getAuthorInfo(req);
  if (!author) return false;

  // Users/agents can only delete their own comments
  return (
    comment.author_type === author.authorType &&
    comment.author_id === author.authorId
  );
}

// ============================================
// Task Comments
// ============================================

/**
 * GET /api/tasks/:id/comments
 * List comments for a task
 */
router.get('/tasks/:id/comments', dualAuth, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);

    // Authorization check
    const access = canAccessTask(req, taskId);
    if (!access.allowed) {
      return access.reason === 'not_found'
        ? response.notFound(res, 'Task')
        : response.forbidden(res, 'Access denied');
    }

    // Verify task exists
    const task = await db.one('SELECT id FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return response.notFound(res, 'Task');
    }

    const comments = await db.many(`
      SELECT * FROM comments
      WHERE commentable_type = 'task' AND commentable_id = ?
      ORDER BY created_at ASC
    `, [taskId]);

    response.success(res, comments.map(formatComment));
  } catch (err) {
    console.error('Error listing task comments:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/tasks/:id/comments
 * Add a comment to a task
 */
router.post('/tasks/:id/comments', dualAuth, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id);
    const { content } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return response.validationError(res, 'Content is required');
    }
    if (content.length > 50000) {
      return response.validationError(res, 'Content must be 50,000 characters or fewer');
    }

    // Verify task exists
    const task = await db.one('SELECT id FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return response.notFound(res, 'Task');
    }

    const author = getAuthorInfo(req);
    if (!author) {
      return response.unauthorized(res, 'Could not determine author');
    }

    const { lastInsertRowid: commentId } = await db.insert(`
      INSERT INTO comments (content, commentable_type, commentable_id, author_type, author_id, author_name)
      VALUES (?, 'task', ?, ?, ?, ?)
    `, [
      content.trim(),
      taskId,
      author.authorType,
      author.authorId,
      author.authorName
    ]);

    const comment = await db.one('SELECT * FROM comments WHERE id = ?', [commentId]);

    response.created(res, formatComment(comment));
  } catch (err) {
    console.error('Error creating task comment:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/tasks/:taskId/comments/:commentId
 * Delete a comment from a task (only own comments, or admin)
 */
router.delete('/tasks/:taskId/comments/:commentId', dualAuth, async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const commentId = parseInt(req.params.commentId);

    // Verify comment exists and belongs to this task
    const comment = await db.one(`
      SELECT * FROM comments
      WHERE id = ? AND commentable_type = 'task' AND commentable_id = ?
    `, [commentId, taskId]);

    if (!comment) {
      return response.notFound(res, 'Comment');
    }

    // Check permission
    if (!canDeleteComment(req, comment)) {
      return response.forbidden(res, 'You can only delete your own comments');
    }

    await db.exec('DELETE FROM comments WHERE id = ?', [commentId]);

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting task comment:', err);
    response.serverError(res);
  }
});

// ============================================
// Deliverable Comments
// ============================================

/**
 * GET /api/deliverables/:id/comments
 * List comments for a deliverable
 */
router.get('/deliverables/:id/comments', dualAuth, async (req, res) => {
  try {
    const deliverableId = parseInt(req.params.id);

    // Authorization check
    const access = canAccessDeliverable(req, deliverableId);
    if (!access.allowed) {
      return access.reason === 'not_found'
        ? response.notFound(res, 'Deliverable')
        : response.forbidden(res, 'Access denied');
    }

    // Verify deliverable exists
    const deliverable = await db.one('SELECT id FROM deliverables WHERE id = ?', [deliverableId]);
    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    const comments = await db.many(`
      SELECT * FROM comments
      WHERE commentable_type = 'deliverable' AND commentable_id = ?
      ORDER BY created_at ASC
    `, [deliverableId]);

    response.success(res, comments.map(formatComment));
  } catch (err) {
    console.error('Error listing deliverable comments:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/deliverables/:id/comments
 * Add a comment to a deliverable
 */
router.post('/deliverables/:id/comments', dualAuth, async (req, res) => {
  try {
    const deliverableId = parseInt(req.params.id);
    const { content } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return response.validationError(res, 'Content is required');
    }
    if (content.length > 50000) {
      return response.validationError(res, 'Content must be 50,000 characters or fewer');
    }

    // Verify deliverable exists
    const deliverable = await db.one('SELECT id FROM deliverables WHERE id = ?', [deliverableId]);
    if (!deliverable) {
      return response.notFound(res, 'Deliverable');
    }

    const author = getAuthorInfo(req);
    if (!author) {
      return response.unauthorized(res, 'Could not determine author');
    }

    const { lastInsertRowid: commentId } = await db.insert(`
      INSERT INTO comments (content, commentable_type, commentable_id, author_type, author_id, author_name)
      VALUES (?, 'deliverable', ?, ?, ?, ?)
    `, [
      content.trim(),
      deliverableId,
      author.authorType,
      author.authorId,
      author.authorName
    ]);

    const comment = await db.one('SELECT * FROM comments WHERE id = ?', [commentId]);

    response.created(res, formatComment(comment));
  } catch (err) {
    console.error('Error creating deliverable comment:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/deliverables/:deliverableId/comments/:commentId
 * Delete a comment from a deliverable (only own comments, or admin)
 */
router.delete('/deliverables/:deliverableId/comments/:commentId', dualAuth, async (req, res) => {
  try {
    const deliverableId = parseInt(req.params.deliverableId);
    const commentId = parseInt(req.params.commentId);

    // Verify comment exists and belongs to this deliverable
    const comment = await db.one(`
      SELECT * FROM comments
      WHERE id = ? AND commentable_type = 'deliverable' AND commentable_id = ?
    `, [commentId, deliverableId]);

    if (!comment) {
      return response.notFound(res, 'Comment');
    }

    // Check permission
    if (!canDeleteComment(req, comment)) {
      return response.forbidden(res, 'You can only delete your own comments');
    }

    await db.exec('DELETE FROM comments WHERE id = ?', [commentId]);

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting deliverable comment:', err);
    response.serverError(res);
  }
});

export default router;
