import { Router } from 'express';
import db from '../db/connection.js';
import * as response from '../utils/response.js';
import { userAuth } from '../middleware/userAuth.js';

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
    console.error('[Activity] JSON parse error:', err.message);
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
 * Normalize timestamp fields on an activity object
 */
function normalizeActivityTimestamps(activity) {
  return {
    ...activity,
    created_at: toISOTimestamp(activity.created_at)
  };
}

/**
 * Normalize timestamp fields on activity stats
 */
function normalizeStatsTimestamps(stats) {
  return {
    ...stats,
    first_activity: toISOTimestamp(stats.first_activity),
    last_activity: toISOTimestamp(stats.last_activity)
  };
}

/**
 * GET /api/activity
 * List agent activity with filtering
 */
router.get('/', userAuth, (req, res) => {
  try {
    const { agentId, action, resourceType, period } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = `
      SELECT
        aa.*,
        a.name as agent_name
      FROM agent_activity aa
      JOIN agents a ON a.id = aa.agent_id
      WHERE 1=1
    `;
    const params = [];

    if (agentId) {
      query += ' AND aa.agent_id = ?';
      params.push(parseInt(agentId));
    }
    if (action) {
      query += ' AND aa.action = ?';
      params.push(action);
    }
    if (resourceType) {
      query += ' AND aa.resource_type = ?';
      params.push(resourceType);
    }
    if (period) {
      let days;
      switch (period) {
        case '24h': days = 1; break;
        case '7d': days = 7; break;
        case '30d': days = 30; break;
        default: days = 7;
      }
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      query += ' AND aa.created_at >= ?';
      params.push(since);
    }

    query += ' ORDER BY aa.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const activities = db.prepare(query).all(...params);

    const parsed = activities.map(a => normalizeActivityTimestamps({
      ...a,
      details: safeJsonParse(a.details, {})
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error listing activity:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/activity/stats
 * Get activity statistics
 */
router.get('/stats', userAuth, (req, res) => {
  try {
    const { agentId, period = '7d' } = req.query;

    // Calculate date range
    let days;
    switch (period) {
      case '24h': days = 1; break;
      case '7d': days = 7; break;
      case '30d': days = 30; break;
      default: days = 7;
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let baseQuery = `
      FROM agent_activity
      WHERE created_at >= ?
    `;
    const baseParams = [since];

    if (agentId) {
      baseQuery += ' AND agent_id = ?';
      baseParams.push(parseInt(agentId));
    }

    // Total actions
    const totalActions = db.prepare(`
      SELECT COUNT(*) as count ${baseQuery}
    `).get(...baseParams).count;

    // Actions by type
    const actionsByType = db.prepare(`
      SELECT action, COUNT(*) as count ${baseQuery}
      GROUP BY action
      ORDER BY count DESC
    `).all(...baseParams);

    // Actions by agent
    const actionsByAgent = db.prepare(`
      SELECT
        a.id as agent_id,
        a.name as agent_name,
        COUNT(aa.id) as count
      FROM agents a
      LEFT JOIN agent_activity aa ON aa.agent_id = a.id AND aa.created_at >= ?
      ${agentId ? 'WHERE a.id = ?' : ''}
      GROUP BY a.id
      ORDER BY count DESC
    `).all(since, ...(agentId ? [parseInt(agentId)] : []));

    // Actions over time (by day)
    const actionsOverTime = db.prepare(`
      SELECT
        date(created_at) as date,
        COUNT(*) as count
      ${baseQuery}
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all(...baseParams);

    response.success(res, {
      period,
      totalActions,
      actionsByType,
      actionsByAgent,
      actionsOverTime
    });
  } catch (err) {
    console.error('Error getting activity stats:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/activity/agents/:id
 * Get activity for a specific agent
 */
router.get('/agents/:id', userAuth, (req, res) => {
  try {
    const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) {
      return response.notFound(res, 'Agent');
    }

    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const activities = db.prepare(`
      SELECT * FROM agent_activity
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.id, limit, offset);

    const parsed = activities.map(a => normalizeActivityTimestamps({
      ...a,
      details: safeJsonParse(a.details, {})
    }));

    // Get summary stats
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_actions,
        COUNT(DISTINCT action) as unique_actions,
        MIN(created_at) as first_activity,
        MAX(created_at) as last_activity
      FROM agent_activity
      WHERE agent_id = ?
    `).get(req.params.id);

    response.success(res, {
      agent,
      stats: normalizeStatsTimestamps(stats),
      activities: parsed
    });
  } catch (err) {
    console.error('Error getting agent activity:', err);
    response.serverError(res);
  }
});

// ============================================
// Universal Activity Log (entity-level)
// ============================================

/**
 * GET /api/activity/entity/:type/:id
 * Get activity log for a specific entity (deliverable or task)
 */
router.get('/entity/:type/:id', userAuth, (req, res) => {
  try {
    const { type, id } = req.params;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    if (!['deliverable', 'task'].includes(type)) {
      return response.validationError(res, 'Entity type must be "deliverable" or "task"');
    }

    const activities = db.prepare(`
      SELECT id, entity_type, entity_id, event_type, actor_name, detail, created_at
      FROM activity_log
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(type, parseInt(id), limit, offset);

    const parsed = activities.map(a => normalizeActivityTimestamps({
      ...a,
      detail: safeJsonParse(a.detail, {})
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error fetching entity activity:', err);
    response.serverError(res);
  }
});

export default router;
