import { Router } from 'express';
import db from '../db/adapter.js';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { agentAuth } from '../middleware/agentAuth.js';
import { generateWebhookSecret } from '../utils/crypto.js';
import { validateWebhookUrl } from '../services/webhooks.js';
import {
  validateBody,
  createWebhookSchema,
  updateWebhookSchema
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
 * Normalize timestamp fields on a webhook object
 */
function normalizeWebhookTimestamps(webhook) {
  return {
    ...webhook,
    created_at: toISOTimestamp(webhook.created_at),
    updated_at: toISOTimestamp(webhook.updated_at),
    last_triggered_at: toISOTimestamp(webhook.last_triggered_at)
  };
}

/**
 * Normalize timestamp fields on a webhook delivery object
 */
function normalizeDeliveryTimestamps(delivery) {
  return {
    ...delivery,
    created_at: toISOTimestamp(delivery.created_at),
    last_attempt_at: toISOTimestamp(delivery.last_attempt_at)
  };
}

// Import from the single source of truth
import { TRIGGER_EVENTS } from '../utils/validation.js';
const WEBHOOK_EVENTS = TRIGGER_EVENTS;

// ============================================
// Agent webhook management (self-service)
// These routes MUST come before /:id routes
// ============================================

/**
 * GET /api/webhooks/mine
 * Get webhooks for current agent
 */
router.get('/mine', agentAuth, async (req, res) => {
  try {
    const webhooks = await db.many(`
      SELECT id, url, events, status, created_at, updated_at
      FROM webhooks
      WHERE agent_id = ?
      ORDER BY created_at DESC
    `, [req.agent.id]);

    const parsed = webhooks.map(w => normalizeWebhookTimestamps({
      ...w,
      events: safeJsonParse(w.events, [])
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error getting agent webhooks:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/webhooks/mine
 * Create webhook for current agent (if allowed)
 */
router.post('/mine', agentAuth, async (req, res) => {
  try {
    // Check if agent has permission to create webhooks
    if (!req.agent.scopes.includes('webhook:create') && !req.agent.scopes.includes('*')) {
      return response.forbidden(res, 'Agent does not have permission to create webhooks');
    }

    const { url, events, status } = req.body;

    if (!url || !events || !Array.isArray(events)) {
      return response.validationError(res, 'url and events array are required');
    }

    // Validate events
    const invalidEvents = events.filter(e => !WEBHOOK_EVENTS.includes(e));
    if (invalidEvents.length > 0) {
      return response.validationError(res, `Invalid events: ${invalidEvents.join(', ')}`);
    }

    // Validate status if provided
    const webhookStatus = status || 'active';
    if (!['active', 'inactive'].includes(webhookStatus)) {
      return response.validationError(res, 'status must be active or inactive');
    }

    // Validate URL format and SSRF protection
    const urlValidation = await validateWebhookUrl(url);
    if (!urlValidation.valid) {
      return response.validationError(res, urlValidation.reason || 'Invalid URL');
    }

    const secret = generateWebhookSecret();

    const { lastInsertRowid: id } = await db.insert(`
      INSERT INTO webhooks (agent_id, url, secret, events, status)
      VALUES (?, ?, ?, ?, ?)
    `, [
      req.agent.id,
      url,
      secret,
      JSON.stringify(events),
      webhookStatus
    ]);

    response.created(res, {
      id,
      url,
      events,
      secret,
      status: webhookStatus,
      message: 'Store this secret securely'
    });
  } catch (err) {
    console.error('Error creating agent webhook:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/webhooks/mine/:id
 * Update webhook for current agent
 */
router.patch('/mine/:id', agentAuth, async (req, res) => {
  try {
    // Check if agent has permission to manage webhooks
    if (!req.agent.scopes.includes('webhook:create') && !req.agent.scopes.includes('*')) {
      return response.forbidden(res, 'Agent does not have permission to manage webhooks');
    }

    // Verify webhook belongs to this agent
    const webhook = await db.one(`
      SELECT id, agent_id FROM webhooks WHERE id = ? AND agent_id = ?
    `, [req.params.id, req.agent.id]);

    if (!webhook) {
      return response.notFound(res, 'Webhook');
    }

    const { url, events, status } = req.body;

    const updates = [];
    const values = [];

    if (url !== undefined) {
      // Validate URL format and SSRF protection
      const urlValidation = await validateWebhookUrl(url);
      if (!urlValidation.valid) {
        return response.validationError(res, urlValidation.reason || 'Invalid URL');
      }
      updates.push('url = ?');
      values.push(url);
    }

    if (events !== undefined) {
      if (!Array.isArray(events)) {
        return response.validationError(res, 'events must be an array');
      }
      const invalidEvents = events.filter(e => !WEBHOOK_EVENTS.includes(e));
      if (invalidEvents.length > 0) {
        return response.validationError(res, `Invalid events: ${invalidEvents.join(', ')}`);
      }
      updates.push('events = ?');
      values.push(JSON.stringify(events));
    }

    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status)) {
        return response.validationError(res, 'status must be active or inactive');
      }
      updates.push('status = ?');
      values.push(status);
    }

    if (updates.length === 0) {
      return response.validationError(res, 'No fields to update');
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    await db.exec(`UPDATE webhooks SET ${updates.join(', ')} WHERE id = ?`, values);

    const updated = await db.one('SELECT * FROM webhooks WHERE id = ?', [req.params.id]);

    response.success(res, normalizeWebhookTimestamps({
      ...updated,
      events: safeJsonParse(updated.events, []),
      secret: undefined,
      hasSecret: !!updated.secret
    }));
  } catch (err) {
    console.error('Error updating agent webhook:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/webhooks/mine/:id
 * Delete webhook for current agent
 */
router.delete('/mine/:id', agentAuth, async (req, res) => {
  try {
    // Check if agent has permission to manage webhooks
    if (!req.agent.scopes.includes('webhook:create') && !req.agent.scopes.includes('*')) {
      return response.forbidden(res, 'Agent does not have permission to manage webhooks');
    }

    // Verify webhook belongs to this agent
    const webhook = await db.one(`
      SELECT id, agent_id FROM webhooks WHERE id = ? AND agent_id = ?
    `, [req.params.id, req.agent.id]);

    if (!webhook) {
      return response.notFound(res, 'Webhook');
    }

    await db.exec('DELETE FROM webhooks WHERE id = ?', [req.params.id]);

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting agent webhook:', err);
    response.serverError(res);
  }
});

// ============================================
// Admin endpoints
// ============================================

/**
 * GET /api/webhooks
 * List all webhooks (admin only)
 */
router.get('/', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const { agentId, status } = req.query;

    let query = `
      SELECT
        w.*,
        a.name as agent_name
      FROM webhooks w
      LEFT JOIN agents a ON a.id = w.agent_id
      WHERE 1=1
    `;
    const params = [];

    if (agentId) {
      query += ' AND w.agent_id = ?';
      params.push(parseInt(agentId));
    }
    if (status) {
      query += ' AND w.status = ?';
      params.push(status);
    }

    query += ' ORDER BY w.created_at DESC';

    const webhooks = await db.many(query, params);

    const parsed = webhooks.map(w => normalizeWebhookTimestamps({
      ...w,
      events: safeJsonParse(w.events, []),
      // Don't expose the secret
      secret: undefined,
      hasSecret: !!w.secret
    }));

    response.success(res, parsed);
  } catch (err) {
    console.error('Error listing webhooks:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/webhooks
 * Create a new webhook
 */
router.post('/', userAuth, requireRoles('admin'), validateBody(createWebhookSchema), async (req, res) => {
  try {
    const { agentId, url, events } = req.body;

    // Validate agent exists
    const agent = await db.one('SELECT id FROM agents WHERE id = ?', [agentId]);
    if (!agent) {
      return response.validationError(res, 'Invalid agent ID');
    }

    // Validate URL format and SSRF protection
    const urlValidation = await validateWebhookUrl(url);
    if (!urlValidation.valid) {
      return response.validationError(res, urlValidation.reason || 'Invalid URL');
    }

    const secret = generateWebhookSecret();

    const { lastInsertRowid: id } = await db.insert(`
      INSERT INTO webhooks (agent_id, url, secret, events)
      VALUES (?, ?, ?, ?)
    `, [
      agentId,
      url,
      secret,
      JSON.stringify(events)
    ]);

    // Return the secret once - it cannot be retrieved again
    response.created(res, {
      id,
      agentId,
      url,
      events,
      secret, // Only time the secret is returned
      status: 'active',
      message: 'Store this secret securely - it will be used to verify webhook signatures'
    });
  } catch (err) {
    console.error('Error creating webhook:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/webhooks/:id
 * Get webhook details
 */
router.get('/:id', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const webhook = await db.one(`
      SELECT
        w.*,
        a.name as agent_name
      FROM webhooks w
      LEFT JOIN agents a ON a.id = w.agent_id
      WHERE w.id = ?
    `, [req.params.id]);

    if (!webhook) {
      return response.notFound(res, 'Webhook');
    }

    // Get recent deliveries
    const deliveries = (await db.many(`
      SELECT id, event_type, status, attempts, response_status, created_at, last_attempt_at
      FROM webhook_deliveries
      WHERE webhook_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `, [req.params.id])).map(normalizeDeliveryTimestamps);

    response.success(res, normalizeWebhookTimestamps({
      ...webhook,
      events: safeJsonParse(webhook.events, []),
      secret: undefined,
      hasSecret: !!webhook.secret,
      deliveries
    }));
  } catch (err) {
    console.error('Error getting webhook:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/webhooks/:id
 * Update webhook
 */
router.patch('/:id', userAuth, requireRoles('admin'), validateBody(updateWebhookSchema), async (req, res) => {
  try {
    const webhook = await db.one('SELECT id FROM webhooks WHERE id = ?', [req.params.id]);
    if (!webhook) {
      return response.notFound(res, 'Webhook');
    }

    const { url, events, status } = req.body;

    const updates = [];
    const values = [];

    if (url !== undefined) {
      // Validate URL format and SSRF protection
      const urlValidation = await validateWebhookUrl(url);
      if (!urlValidation.valid) {
        return response.validationError(res, urlValidation.reason || 'Invalid URL');
      }
      updates.push('url = ?');
      values.push(url);
    }
    if (events !== undefined) {
      updates.push('events = ?');
      values.push(JSON.stringify(events));
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    await db.exec(`UPDATE webhooks SET ${updates.join(', ')} WHERE id = ?`, values);

    const updated = await db.one('SELECT * FROM webhooks WHERE id = ?', [req.params.id]);

    response.success(res, normalizeWebhookTimestamps({
      ...updated,
      events: safeJsonParse(updated.events, []),
      secret: undefined,
      hasSecret: !!updated.secret
    }));
  } catch (err) {
    console.error('Error updating webhook:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/webhooks/:id
 * Delete webhook
 */
router.delete('/:id', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const webhook = await db.one('SELECT id FROM webhooks WHERE id = ?', [req.params.id]);
    if (!webhook) {
      return response.notFound(res, 'Webhook');
    }

    await db.exec('DELETE FROM webhooks WHERE id = ?', [req.params.id]);

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting webhook:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/webhooks/:id/rotate-secret
 * Rotate webhook secret
 */
router.post('/:id/rotate-secret', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const webhook = await db.one('SELECT id FROM webhooks WHERE id = ?', [req.params.id]);
    if (!webhook) {
      return response.notFound(res, 'Webhook');
    }

    const secret = generateWebhookSecret();

    await db.exec(`
      UPDATE webhooks SET secret = ?, updated_at = datetime('now') WHERE id = ?
    `, [secret, req.params.id]);

    response.success(res, {
      secret,
      message: 'Store this secret securely - it will be used to verify webhook signatures'
    });
  } catch (err) {
    console.error('Error rotating webhook secret:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/webhooks/:id/deliveries
 * Get webhook delivery history
 */
router.get('/:id/deliveries', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const webhook = await db.one('SELECT id FROM webhooks WHERE id = ?', [req.params.id]);
    if (!webhook) {
      return response.notFound(res, 'Webhook');
    }

    const { status } = req.query;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    let query = 'SELECT * FROM webhook_deliveries WHERE webhook_id = ?';
    const params = [req.params.id];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const deliveries = await db.many(query, params);

    response.success(res, deliveries.map(normalizeDeliveryTimestamps));
  } catch (err) {
    console.error('Error getting webhook deliveries:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/webhooks/:id/deliveries/:deliveryId/retry
 * Retry a failed webhook delivery
 */
router.post('/:id/deliveries/:deliveryId/retry', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const delivery = await db.one(`
      SELECT d.*, w.url, w.secret
      FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.id = ? AND d.webhook_id = ?
    `, [req.params.deliveryId, req.params.id]);

    if (!delivery) {
      return response.notFound(res, 'Delivery');
    }

    // Import and use the delivery function
    const { deliverWebhook } = await import('../services/webhooks.js');
    const result = await deliverWebhook(delivery.id);

    response.success(res, { retried: true, result });
  } catch (err) {
    console.error('Error retrying webhook delivery:', err);
    response.serverError(res);
  }
});

export default router;
