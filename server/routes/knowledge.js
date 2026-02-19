import { Router } from 'express';
import db from '../db/connection.js';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { dualAuth } from '../middleware/agentAuth.js';
import { triggerWebhookForProject } from '../services/webhooks.js';
import { dispatchEvent } from '../services/routeDispatcher.js';
import {
  validateBody,
  validateQuery,
  createKnowledgeSchema,
  updateKnowledgeSchema,
  searchKnowledgeSchema
} from '../utils/validation.js';

const router = Router();

function safeJsonParse(str, defaultValue = null) {
  if (str === null || str === undefined) return defaultValue;
  if (typeof str !== 'string') return str;
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

/**
 * Coerce a tags value into an array.
 * Handles: JSON arrays, comma-separated strings, or null/undefined.
 */
function parseTags(raw) {
  if (!raw) return [];
  // Try JSON first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON — treat as comma-separated string
  }
  if (typeof raw === 'string') {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
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
 * Normalize timestamp fields on a knowledge object
 */
function normalizeKnowledgeTimestamps(knowledge) {
  return {
    ...knowledge,
    created_at: toISOTimestamp(knowledge.created_at),
    updated_at: toISOTimestamp(knowledge.updated_at)
  };
}

/**
 * GET /api/knowledge/search
 * Search knowledge base (accessible by agents)
 * NOTE: This route MUST come before /:id to avoid "search" being matched as an ID
 */
router.get('/search', dualAuth, validateQuery(searchKnowledgeSchema), (req, res) => {
  try {
    const { q, projectId, category, limit = 20 } = req.query;

    let query = `
      SELECT
        k.*,
        p.name as project_name
      FROM knowledge k
      LEFT JOIN projects p ON p.id = k.project_id
      WHERE (k.title LIKE ? OR k.content LIKE ?)
    `;
    const searchTerm = `%${q}%`;
    const params = [searchTerm, searchTerm];

    // For agents (not user keys), restrict to projects they have tasks in
    if (req.agent && req.agent.id && !req.agent.isUserKey) {
      query += ` AND (k.project_id IS NULL OR k.project_id IN (
        SELECT DISTINCT project_id FROM tasks WHERE assigned_agent_id = ?
      ))`;
      params.push(req.agent.id);
    }

    if (projectId && !isNaN(parseInt(projectId))) {
      query += ' AND k.project_id = ?';
      params.push(parseInt(projectId));
    }
    if (category) {
      query += ' AND k.category = ?';
      params.push(category);
    }

    query += ' ORDER BY k.created_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const results = db.prepare(query).all(...params);

    const parsed = results.map(k => normalizeKnowledgeTimestamps({
      ...k,
      tags: parseTags(k.tags),
      // Include a snippet of the content
      snippet: k.content.substring(0, 200) + (k.content.length > 200 ? '...' : '')
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error searching knowledge:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/knowledge
 * List all knowledge entries with filtering
 * Supports both user auth (session/user keys) and agent auth (agent keys)
 */
router.get('/', dualAuth, (req, res) => {
  try {
    const { projectId, category, search, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT
        k.*,
        p.name as project_name
      FROM knowledge k
      LEFT JOIN projects p ON p.id = k.project_id
      WHERE 1=1
    `;
    const params = [];

    if (projectId && !isNaN(parseInt(projectId))) {
      query += ' AND k.project_id = ?';
      params.push(parseInt(projectId));
    }
    if (category) {
      query += ' AND k.category = ?';
      params.push(category);
    }
    if (search) {
      query += ' AND (k.title LIKE ? OR k.content LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY k.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const knowledge = db.prepare(query).all(...params);

    const parsed = knowledge.map(k => normalizeKnowledgeTimestamps({
      ...k,
      tags: parseTags(k.tags)
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error listing knowledge:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/knowledge
 * Create a new knowledge entry
 */
router.post('/', userAuth, validateBody(createKnowledgeSchema), (req, res) => {
  try {
    const { projectId, title, content, contentType, category, tags } = req.body;

    // Validate project exists if provided
    if (projectId) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!project) {
        return response.validationError(res, 'Invalid project ID');
      }
    }

    const result = db.prepare(`
      INSERT INTO knowledge (project_id, title, content, content_type, category, tags)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      projectId || null,
      title,
      content,
      contentType || 'markdown',
      category || null,
      JSON.stringify(tags || [])
    );

    const knowledge = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(result.lastInsertRowid);

    // Trigger webhook for project knowledge update
    if (projectId) {
      triggerWebhookForProject(projectId, 'project.knowledge_updated', {
        projectId,
        knowledge: {
          ...knowledge,
          tags: parseTags(knowledge.tags)
        },
        action: 'created'
      });

      // Dispatch knowledge.updated delivery route event
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
      dispatchEvent('knowledge.updated', {
        project: project ? { id: project.id, name: project.name } : { id: projectId },
        projectId,
        knowledge: {
          id: knowledge.id,
          title: knowledge.title,
          category: knowledge.category,
          content_type: knowledge.content_type,
          tags: parseTags(knowledge.tags)
        },
        action: 'created',
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Knowledge] Route dispatch error:', err));
    }

    response.created(res, normalizeKnowledgeTimestamps({
      ...knowledge,
      tags: parseTags(knowledge.tags)
    }));
  } catch (err) {
    console.error('Error creating knowledge:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/knowledge/:id
 * Get knowledge entry details
 */
router.get('/:id', dualAuth, (req, res) => {
  try {
    const knowledge = db.prepare(`
      SELECT
        k.*,
        p.name as project_name
      FROM knowledge k
      LEFT JOIN projects p ON p.id = k.project_id
      WHERE k.id = ?
    `).get(req.params.id);

    if (!knowledge) {
      return response.notFound(res, 'Knowledge');
    }

    response.success(res, normalizeKnowledgeTimestamps({
      ...knowledge,
      tags: parseTags(knowledge.tags)
    }));
  } catch (err) {
    console.error('Error getting knowledge:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/knowledge/:id
 * Update knowledge entry
 */
router.patch('/:id', userAuth, validateBody(updateKnowledgeSchema), (req, res) => {
  try {
    const knowledge = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(req.params.id);
    if (!knowledge) {
      return response.notFound(res, 'Knowledge');
    }

    const { title, content, contentType, category, tags } = req.body;

    const updates = [];
    const values = [];

    if (title !== undefined) {
      updates.push('title = ?');
      values.push(title);
    }
    if (content !== undefined) {
      updates.push('content = ?');
      values.push(content);
    }
    if (contentType !== undefined) {
      updates.push('content_type = ?');
      values.push(contentType);
    }
    if (category !== undefined) {
      updates.push('category = ?');
      values.push(category);
    }
    if (tags !== undefined) {
      updates.push('tags = ?');
      values.push(JSON.stringify(tags));
    }

    if (updates.length === 0) {
      return response.validationError(res, 'No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    db.prepare(`UPDATE knowledge SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(req.params.id);

    // Trigger webhook
    if (updated.project_id) {
      triggerWebhookForProject(updated.project_id, 'project.knowledge_updated', {
        projectId: updated.project_id,
        knowledge: {
          ...updated,
          tags: parseTags(updated.tags)
        },
        action: 'updated'
      });

      // Dispatch knowledge.updated delivery route event
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(updated.project_id);
      dispatchEvent('knowledge.updated', {
        project: project ? { id: project.id, name: project.name } : { id: updated.project_id },
        projectId: updated.project_id,
        knowledge: {
          id: updated.id,
          title: updated.title,
          category: updated.category,
          content_type: updated.content_type,
          tags: parseTags(updated.tags)
        },
        action: 'updated',
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Knowledge] Route dispatch error:', err));
    }

    response.success(res, normalizeKnowledgeTimestamps({
      ...updated,
      tags: parseTags(updated.tags)
    }));
  } catch (err) {
    console.error('Error updating knowledge:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/knowledge/:id
 * Delete knowledge entry
 */
router.delete('/:id', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const knowledge = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(req.params.id);
    if (!knowledge) {
      return response.notFound(res, 'Knowledge');
    }

    db.prepare('DELETE FROM knowledge WHERE id = ?').run(req.params.id);

    // Trigger webhook
    if (knowledge.project_id) {
      triggerWebhookForProject(knowledge.project_id, 'project.knowledge_updated', {
        projectId: knowledge.project_id,
        knowledgeId: knowledge.id,
        action: 'deleted'
      });

      // Dispatch knowledge.updated delivery route event
      const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(knowledge.project_id);
      dispatchEvent('knowledge.updated', {
        project: project ? { id: project.id, name: project.name } : { id: knowledge.project_id },
        projectId: knowledge.project_id,
        knowledge: {
          id: knowledge.id,
          title: knowledge.title,
          category: knowledge.category
        },
        action: 'deleted',
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[Knowledge] Route dispatch error:', err));
    }

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting knowledge:', err);
    response.serverError(res);
  }
});

export default router;
