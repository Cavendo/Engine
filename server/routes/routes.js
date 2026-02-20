/**
 * Routes API Endpoints
 * Manages delivery routes for routing approved deliverables to external systems
 */

import express from 'express';
import db from '../db/connection.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import * as response from '../utils/response.js';
import { validateBody, validateParams, validateQuery, idParamSchema, TRIGGER_EVENTS, validateEndpoint, validateEndpointWithDns } from '../utils/validation.js';
import { z } from 'zod';
import { dispatchRoute, testRoute } from '../services/routeDispatcher.js';
import { safeJsonParse, sanitizeDestinationConfig, formatDeliveryLog } from '../utils/routeHelpers.js';

const router = express.Router();

/**
 * Normalize SQLite timestamps to ISO 8601 format
 */
function toISOTimestamp(timestamp) {
  if (!timestamp) return null;
  // Already ISO format
  if (timestamp.includes('T')) return timestamp;
  // SQLite format: "2026-02-16 18:04:51" → "2026-02-16T18:04:51.000Z"
  return timestamp.replace(' ', 'T') + '.000Z';
}

// ============================================
// Validation Schemas
// ============================================

export const DESTINATION_TYPES = ['webhook', 'email', 'storage', 'slack'];

const triggerConditionsSchema = z.object({
  tags: z.object({
    includes_any: z.array(z.string()).optional(),
    includes_all: z.array(z.string()).optional()
  }).optional(),
  metadata: z.record(z.any()).optional()
}).optional().nullable();

const retryPolicySchema = z.object({
  max_retries: z.number().int().min(0).max(10).default(3),
  backoff_type: z.enum(['exponential', 'linear', 'fixed']).default('exponential'),
  initial_delay_ms: z.number().int().min(100).max(60000).default(1000)
}).optional();

const webhookConfigSchema = z.object({
  url: z.string().url('Invalid URL'),
  method: z.enum(['POST', 'PUT', 'PATCH']).optional().default('POST'),
  headers: z.record(z.string()).optional(),
  signing_secret: z.string().optional(),
  timeout_ms: z.number().int().min(1000).max(30000).optional().default(10000),
  payload_template: z.string().optional()
});

const storageConfigSchema = z.object({
  provider: z.enum(['s3']),
  connection_id: z.number().int().positive().optional(),
  bucket: z.string().min(1).optional(),
  region: z.string().optional().default('us-east-1'),
  endpoint: z.string().url().optional().refine(
    val => val === undefined || validateEndpoint(val),
    { message: 'Endpoint must not target internal or private addresses' }
  ),
  access_key_id: z.string().min(1).optional(),
  secret_access_key: z.string().min(1).optional(),
  path_prefix: z.string().max(500).optional().default(''),
  upload_content: z.boolean().optional().default(true),
  upload_files: z.boolean().optional().default(true)
}).refine(data => {
  if (data.connection_id) return true;
  return data.bucket && data.access_key_id && data.secret_access_key;
}, { message: 'Either connection_id or inline credentials (bucket, access_key_id, secret_access_key) are required' });

const emailConfigSchema = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient required'),
  cc: z.array(z.string().email()).optional(),
  from_name: z.string().max(100).optional(),
  from_address: z.string().email().optional(),
  subject_template: z.string().max(500).optional(),
  template: z.enum(['deliverable_submitted', 'deliverable_approved', 'revision_requested', 'daily_digest']).optional(),
  include_content_preview: z.boolean().optional().default(true),
  attach_files: z.boolean().optional().default(false),
  reply_to: z.string().email().optional()
});

const slackConfigSchema = z.object({
  webhook_url: z.string().url('Must be a valid Slack webhook URL'),
  channel_label: z.string().max(100).optional(),
  message_style: z.enum(['rich', 'simple']).optional().default('rich'),
  include_content_preview: z.boolean().optional().default(true),
  include_files_list: z.boolean().optional().default(true),
  include_actions: z.boolean().optional().default(true),
  unfurl_links: z.boolean().optional().default(false),
  timeout_ms: z.number().int().min(1000).max(30000).optional().default(10000)
});

const createRouteSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().max(2000).optional().nullable(),
  trigger_event: z.enum(TRIGGER_EVENTS, {
    errorMap: () => ({ message: `Trigger event must be one of: ${TRIGGER_EVENTS.join(', ')}` })
  }),
  trigger_conditions: triggerConditionsSchema,
  destination_type: z.enum(DESTINATION_TYPES, {
    errorMap: () => ({ message: `Destination type must be one of: ${DESTINATION_TYPES.join(', ')}` })
  }),
  destination_config: z.any(), // Validated separately based on destination_type
  field_mapping: z.record(z.string()).optional().nullable(),
  retry_policy: retryPolicySchema,
  enabled: z.boolean().optional().default(true)
}).refine(
  (data) => {
    // Validate destination_config based on destination_type
    if (data.destination_type === 'webhook') {
      return webhookConfigSchema.safeParse(data.destination_config).success;
    } else if (data.destination_type === 'email') {
      return emailConfigSchema.safeParse(data.destination_config).success;
    } else if (data.destination_type === 'storage') {
      return storageConfigSchema.safeParse(data.destination_config).success;
    } else if (data.destination_type === 'slack') {
      return slackConfigSchema.safeParse(data.destination_config).success;
    }
    return false;
  },
  { message: 'Invalid destination configuration for the specified destination type' }
);

const updateRouteSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional().nullable(),
  trigger_event: z.enum(TRIGGER_EVENTS).optional(),
  trigger_conditions: triggerConditionsSchema,
  destination_type: z.enum(DESTINATION_TYPES).optional(),
  destination_config: z.any().optional(),
  field_mapping: z.record(z.string()).optional().nullable(),
  retry_policy: retryPolicySchema,
  enabled: z.boolean().optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
}).refine(
  (data) => {
    // If destination_config is provided, validate based on destination_type
    // If destination_type is also provided, use that; otherwise validation happens in handler
    if (data.destination_config !== undefined && data.destination_type !== undefined) {
      if (data.destination_type === 'webhook') {
        return webhookConfigSchema.safeParse(data.destination_config).success;
      } else if (data.destination_type === 'email') {
        return emailConfigSchema.safeParse(data.destination_config).success;
      } else if (data.destination_type === 'storage') {
        return storageConfigSchema.safeParse(data.destination_config).success;
      } else if (data.destination_type === 'slack') {
        return slackConfigSchema.safeParse(data.destination_config).success;
      }
      return false;
    }
    return true;
  },
  { message: 'Invalid destination configuration for the specified destination type' }
);

const logsQuerySchema = z.object({
  status: z.enum(['pending', 'delivered', 'failed', 'retrying']).optional(),
  after: z.string().datetime().optional(),
  event_type: z.string().optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).default('50'),
  offset: z.string().regex(/^\d+$/).transform(Number).default('0')
}).partial();

// ============================================
// Helper Functions (imported from utils/routeHelpers.js)
// ============================================

/**
 * Format a route from database format to API response format.
 * @param {object} route - The route row from database
 * @param {boolean} isAdmin - Whether the requesting user is an admin (default: false)
 * @returns {object} Formatted route
 */
function formatRoute(route, isAdmin = false) {
  const destinationType = route.destination_type;
  const destinationConfig = safeJsonParse(route.destination_config, {});

  return {
    ...route,
    trigger_conditions: safeJsonParse(route.trigger_conditions, null),
    destination_config: sanitizeDestinationConfig(destinationConfig, destinationType, isAdmin),
    field_mapping: safeJsonParse(route.field_mapping, null),
    retry_policy: safeJsonParse(route.retry_policy, { max_retries: 3, backoff_type: 'exponential', initial_delay_ms: 1000 }),
    enabled: !!route.enabled,
    created_at: toISOTimestamp(route.created_at),
    updated_at: toISOTimestamp(route.updated_at),
    last_fired_at: toISOTimestamp(route.last_fired_at)
  };
}

// ============================================
// Global Routes (system-level, no project scope)
// ============================================

/**
 * GET /api/routes/global
 * List all global routes (project_id IS NULL)
 */
router.get('/routes/global', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const routes = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM delivery_logs dl WHERE dl.route_id = r.id AND dl.status = 'delivered') as success_count,
        (SELECT COUNT(*) FROM delivery_logs dl WHERE dl.route_id = r.id AND dl.status = 'failed') as failure_count,
        (SELECT MAX(dispatched_at) FROM delivery_logs dl WHERE dl.route_id = r.id) as last_fired_at
      FROM routes r
      WHERE r.project_id IS NULL
      ORDER BY r.created_at DESC
    `).all();

    response.success(res, routes.map(r => formatRoute(r, true)));
  } catch (err) {
    console.error('Error listing global routes:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/routes/global
 * Create a global route (fires for system-level events)
 */
router.post('/routes/global', userAuth, requireRoles('admin'), validateBody(createRouteSchema), async (req, res) => {
  try {
    const {
      name, description, trigger_event, trigger_conditions,
      destination_type, destination_config, field_mapping, retry_policy, enabled
    } = req.body;

    // DNS-level SSRF check for inline storage endpoints
    if (destination_type === 'storage' && destination_config?.endpoint) {
      const check = await validateEndpointWithDns(destination_config.endpoint);
      if (!check.valid) {
        return response.error(res, `Storage endpoint blocked: ${check.reason}`, 400, 'SSRF_BLOCKED');
      }
    }

    const result = db.prepare(`
      INSERT INTO routes (
        project_id, name, description, trigger_event, trigger_conditions,
        destination_type, destination_config, field_mapping, retry_policy, enabled
      )
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      description || null,
      trigger_event,
      JSON.stringify(trigger_conditions || null),
      destination_type,
      JSON.stringify(destination_config),
      JSON.stringify(field_mapping || null),
      JSON.stringify(retry_policy || { max_retries: 3, backoff_type: 'exponential', initial_delay_ms: 1000 }),
      enabled ? 1 : 0
    );

    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(result.lastInsertRowid);
    response.created(res, formatRoute(route, true));
  } catch (err) {
    console.error('Error creating global route:', err);
    response.serverError(res);
  }
});

// ============================================
// Project-scoped Routes
// ============================================

/**
 * POST /api/projects/:id/routes
 * Create a route for a project
 */
router.post('/projects/:id/routes', userAuth, requireRoles('admin'), validateParams(idParamSchema), validateBody(createRouteSchema), async (req, res) => {
  try {
    const projectId = req.params.id;

    // Verify project exists
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return response.notFound(res, 'Project');
    }

    const {
      name,
      description,
      trigger_event,
      trigger_conditions,
      destination_type,
      destination_config,
      field_mapping,
      retry_policy,
      enabled
    } = req.body;

    // DNS-level SSRF check for inline storage endpoints
    if (destination_type === 'storage' && destination_config?.endpoint) {
      const check = await validateEndpointWithDns(destination_config.endpoint);
      if (!check.valid) {
        return response.error(res, `Storage endpoint blocked: ${check.reason}`, 400, 'SSRF_BLOCKED');
      }
    }

    const result = db.prepare(`
      INSERT INTO routes (
        project_id, name, description, trigger_event, trigger_conditions,
        destination_type, destination_config, field_mapping, retry_policy, enabled
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      name,
      description || null,
      trigger_event,
      JSON.stringify(trigger_conditions || null),
      destination_type,
      JSON.stringify(destination_config),
      JSON.stringify(field_mapping || null),
      JSON.stringify(retry_policy || { max_retries: 3, backoff_type: 'exponential', initial_delay_ms: 1000 }),
      enabled ? 1 : 0
    );

    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(result.lastInsertRowid);
    // Admin-only endpoint, so show full config
    response.created(res, formatRoute(route, true));
  } catch (err) {
    console.error('Error creating route:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/projects/:id/routes
 * List routes for a project
 * Note: Sensitive config fields are redacted for non-admin users
 */
router.get('/projects/:id/routes', userAuth, validateParams(idParamSchema), async (req, res) => {
  try {
    const projectId = req.params.id;
    const isAdmin = req.user?.role === 'admin';

    // Verify project exists
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return response.notFound(res, 'Project');
    }

    const routes = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM delivery_logs dl WHERE dl.route_id = r.id AND dl.status = 'delivered') as success_count,
        (SELECT COUNT(*) FROM delivery_logs dl WHERE dl.route_id = r.id AND dl.status = 'failed') as failure_count,
        (SELECT MAX(dispatched_at) FROM delivery_logs dl WHERE dl.route_id = r.id) as last_fired_at
      FROM routes r
      WHERE r.project_id = ?
      ORDER BY r.created_at DESC
    `).all(projectId);

    response.success(res, routes.map(r => formatRoute(r, isAdmin)));
  } catch (err) {
    console.error('Error listing routes:', err);
    response.serverError(res);
  }
});

// ============================================
// Individual Route Endpoints
// ============================================

/**
 * GET /api/routes/:id
 * Get route details
 * Note: Sensitive config fields are redacted for non-admin users
 */
router.get('/routes/:id', userAuth, validateParams(idParamSchema), async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';

    const route = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM delivery_logs dl WHERE dl.route_id = r.id AND dl.status = 'delivered') as success_count,
        (SELECT COUNT(*) FROM delivery_logs dl WHERE dl.route_id = r.id AND dl.status = 'failed') as failure_count,
        (SELECT MAX(dispatched_at) FROM delivery_logs dl WHERE dl.route_id = r.id) as last_fired_at
      FROM routes r
      WHERE r.id = ?
    `).get(req.params.id);

    if (!route) {
      return response.notFound(res, 'Route');
    }

    response.success(res, formatRoute(route, isAdmin));
  } catch (err) {
    console.error('Error getting route:', err);
    response.serverError(res);
  }
});

/**
 * PUT /api/routes/:id
 * Update route configuration
 */
router.put('/routes/:id', userAuth, requireRoles('admin'), validateParams(idParamSchema), validateBody(updateRouteSchema), async (req, res) => {
  try {
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id);
    if (!route) {
      return response.notFound(res, 'Route');
    }

    const updates = [];
    const values = [];

    const {
      name,
      description,
      trigger_event,
      trigger_conditions,
      destination_type,
      destination_config,
      field_mapping,
      retry_policy,
      enabled
    } = req.body;

    // Validate destination_config against destination_type (existing or provided)
    if (destination_config !== undefined) {
      const effectiveType = destination_type !== undefined ? destination_type : route.destination_type;
      let configValid = false;
      if (effectiveType === 'webhook') {
        configValid = webhookConfigSchema.safeParse(destination_config).success;
      } else if (effectiveType === 'email') {
        configValid = emailConfigSchema.safeParse(destination_config).success;
      } else if (effectiveType === 'storage') {
        configValid = storageConfigSchema.safeParse(destination_config).success;
      } else if (effectiveType === 'slack') {
        configValid = slackConfigSchema.safeParse(destination_config).success;
      }
      if (!configValid) {
        return response.validationError(res, 'Invalid destination configuration for the specified destination type');
      }

      // DNS-level SSRF check for inline storage endpoints
      if (effectiveType === 'storage' && destination_config?.endpoint) {
        const check = await validateEndpointWithDns(destination_config.endpoint);
        if (!check.valid) {
          return response.error(res, `Storage endpoint blocked: ${check.reason}`, 400, 'SSRF_BLOCKED');
        }
      }
    }

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (trigger_event !== undefined) {
      updates.push('trigger_event = ?');
      values.push(trigger_event);
    }
    if (trigger_conditions !== undefined) {
      updates.push('trigger_conditions = ?');
      values.push(JSON.stringify(trigger_conditions));
    }
    if (destination_type !== undefined) {
      updates.push('destination_type = ?');
      values.push(destination_type);
    }
    if (destination_config !== undefined) {
      updates.push('destination_config = ?');
      values.push(JSON.stringify(destination_config));
    }
    if (field_mapping !== undefined) {
      updates.push('field_mapping = ?');
      values.push(JSON.stringify(field_mapping));
    }
    if (retry_policy !== undefined) {
      updates.push('retry_policy = ?');
      values.push(JSON.stringify(retry_policy));
    }
    if (enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(enabled ? 1 : 0);
    }

    updates.push('updated_at = datetime(\'now\')');
    values.push(req.params.id);

    db.prepare(`
      UPDATE routes SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    const updated = db.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id);
    // Admin-only endpoint, so show full config
    response.success(res, formatRoute(updated, true));
  } catch (err) {
    console.error('Error updating route:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/routes/:id
 * Delete a route
 */
router.delete('/routes/:id', userAuth, requireRoles('admin'), validateParams(idParamSchema), async (req, res) => {
  try {
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id);
    if (!route) {
      return response.notFound(res, 'Route');
    }

    db.prepare('DELETE FROM routes WHERE id = ?').run(req.params.id);
    response.success(res, { message: 'Route deleted successfully' });
  } catch (err) {
    console.error('Error deleting route:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/routes/:id/test
 * Send test payload to destination
 */
router.post('/routes/:id/test', userAuth, requireRoles('admin'), validateParams(idParamSchema), async (req, res) => {
  try {
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id);
    if (!route) {
      return response.notFound(res, 'Route');
    }

    // Create a test payload
    const testPayload = {
      event: route.trigger_event,
      timestamp: new Date().toISOString(),
      delivery_id: `test_${Date.now()}`,
      test: true,
      project: {
        id: route.project_id,
        name: 'Test Project'
      },
      deliverable: {
        id: 0,
        title: 'Test Deliverable',
        content: 'This is a test payload sent from Cavendo Engine route testing.',
        summary: 'Test summary for route verification',
        status: 'approved',
        created_at: new Date().toISOString()
      }
    };

    const result = await testRoute(formatRoute(route), testPayload);

    if (result.success) {
      response.success(res, {
        success: true,
        message: 'Test payload sent successfully',
        response: result.response
      });
    } else {
      res.status(400).json({
        success: false,
        error: {
          code: 'TEST_FAILED',
          message: result.error || 'Test delivery failed',
          detail: result.detail || null
        }
      });
    }
  } catch (err) {
    console.error('Error testing route:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/routes/:id/logs
 * Get delivery log for a route
 */
router.get('/routes/:id/logs', userAuth, validateParams(idParamSchema), validateQuery(logsQuerySchema), async (req, res) => {
  try {
    const route = db.prepare('SELECT id FROM routes WHERE id = ?').get(req.params.id);
    if (!route) {
      return response.notFound(res, 'Route');
    }

    const { status, after, event_type, limit, offset } = req.query;

    let query = 'SELECT * FROM delivery_logs WHERE route_id = ?';
    const params = [req.params.id];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (after) {
      query += ' AND dispatched_at > ?';
      params.push(after);
    }
    if (event_type) {
      query += ' AND event_type = ?';
      params.push(event_type);
    }

    query += ' ORDER BY dispatched_at DESC LIMIT ? OFFSET ?';
    params.push(limit || 50, offset || 0);

    const logs = db.prepare(query).all(...params);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM delivery_logs WHERE route_id = ?';
    const countParams = [req.params.id];
    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }
    if (after) {
      countQuery += ' AND dispatched_at > ?';
      countParams.push(after);
    }
    if (event_type) {
      countQuery += ' AND event_type = ?';
      countParams.push(event_type);
    }
    const { total } = db.prepare(countQuery).get(...countParams);

    const isAdmin = req.user?.role === 'admin';
    response.success(res, {
      logs: logs.map(log => formatDeliveryLog(log, isAdmin)),
      pagination: {
        total,
        limit: limit || 50,
        offset: offset || 0
      }
    });
  } catch (err) {
    console.error('Error getting delivery logs:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/routes/:id/logs/:logId/retry
 * Manually retry a failed delivery
 */
router.post('/routes/:id/logs/:logId/retry', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const { id: routeId, logId } = req.params;

    const log = db.prepare(`
      SELECT dl.*, r.destination_type, r.destination_config, r.field_mapping
      FROM delivery_logs dl
      JOIN routes r ON r.id = dl.route_id
      WHERE dl.id = ? AND dl.route_id = ?
    `).get(logId, routeId);

    if (!log) {
      return response.notFound(res, 'Delivery log');
    }

    if (log.status === 'delivered') {
      return response.error(res, 'This delivery was already successful', 400, 'ALREADY_DELIVERED');
    }

    // Get the route
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);

    // Reconstruct event data, enriching with assignee info if missing
    const eventData = safeJsonParse(log.event_payload, {});
    if (!eventData.assignee && eventData.task?.assigned_agent_id) {
      const agent = db.prepare('SELECT id, name, execution_mode, owner_user_id FROM agents WHERE id = ?').get(eventData.task.assigned_agent_id);
      if (agent) {
        const assignee = { id: agent.id, name: agent.name, executionMode: agent.execution_mode };
        if (agent.owner_user_id) {
          const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(agent.owner_user_id);
          if (user) { assignee.email = user.email; assignee.userName = user.name; }
        }
        eventData.assignee = assignee;
        eventData.agent = assignee;
      }
    }

    // Retry the delivery
    const result = await dispatchRoute(
      formatRoute(route),
      eventData,
      logId
    );

    if (result.success) {
      response.success(res, {
        success: true,
        message: 'Delivery retried successfully'
      });
    } else {
      response.error(res, result.error || 'Retry delivery failed', 400, 'RETRY_FAILED');
    }
  } catch (err) {
    console.error('Error retrying delivery:', err);
    response.serverError(res);
  }
});

export default router;
