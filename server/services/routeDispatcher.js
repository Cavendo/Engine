/**
 * Route Dispatcher Service
 * Handles route matching, payload building, and delivery dispatch
 */

import db from '../db/connection.js';
import crypto from 'crypto';
import { sendEmail, isConfigured as isEmailConfigured } from './emailProvider.js';
import { uploadToS3, testS3Connection } from './s3Provider.js';
import { sendSlackMessage, testSlackConnection } from './slackProvider.js';
import { validateWebhookUrl } from './webhooks.js';
import { decrypt } from '../utils/crypto.js';
import _Handlebars from 'handlebars';

// Sandboxed Handlebars instance — no prototype access, no custom helpers
const Handlebars = _Handlebars.create();
Handlebars.registerHelper('lookup', function () {
  throw new Error('lookup helper is disabled for security');
});
Handlebars.registerHelper('helperMissing', function () {
  return '';
});
import { logActivity } from './activityLogger.js';
import fs from 'fs';
import path from 'path';

// ============================================
// Route Matching
// ============================================

/**
 * Find all matching routes for an event
 * @param {number} projectId - Project ID
 * @param {string} eventType - Event type (e.g., 'deliverable.approved')
 * @param {Object} eventData - Event data for condition matching
 * @returns {Array} Matching routes
 */
export function findMatchingRoutes(projectId, eventType, eventData = {}) {
  let routes;
  if (projectId) {
    // Project-scoped: match project routes + global routes for this event
    routes = db.prepare(`
      SELECT * FROM routes
      WHERE (project_id = ? OR project_id IS NULL) AND trigger_event = ? AND enabled = 1
    `).all(projectId, eventType);
  } else {
    // System-level event (no project): only match global routes
    routes = db.prepare(`
      SELECT * FROM routes
      WHERE project_id IS NULL AND trigger_event = ? AND enabled = 1
    `).all(eventType);
  }

  return routes.filter(route => {
    const conditions = safeJsonParse(route.trigger_conditions, null);
    if (!conditions) return true;
    return evaluateConditions(conditions, eventData);
  }).map(formatRoute);
}

/**
 * Evaluate trigger conditions against event data
 */
function evaluateConditions(conditions, eventData) {
  // Tag conditions
  if (conditions.tags) {
    const eventTags = eventData.tags || eventData.deliverable?.tags || [];

    if (conditions.tags.includes_any) {
      const hasAny = conditions.tags.includes_any.some(tag => eventTags.includes(tag));
      if (!hasAny) return false;
    }

    if (conditions.tags.includes_all) {
      const hasAll = conditions.tags.includes_all.every(tag => eventTags.includes(tag));
      if (!hasAll) return false;
    }
  }

  // Metadata conditions
  if (conditions.metadata) {
    const metadata = eventData.metadata || eventData.deliverable?.metadata || {};
    for (const [key, value] of Object.entries(conditions.metadata)) {
      if (metadata[key] !== value) return false;
    }
  }

  return true;
}

// ============================================
// Event Dispatching
// ============================================

/**
 * Dispatch an event to all matching routes
 * @param {string} eventType - Event type
 * @param {Object} eventData - Full event data
 */
export async function dispatchEvent(eventType, eventData) {
  const projectId = eventData.project?.id || eventData.projectId || null;

  // Inject event type so email templates and payloads can reference it
  const enrichedData = { ...eventData, event: eventType };

  const routes = findMatchingRoutes(projectId, eventType, enrichedData);

  if (routes.length === 0) {
    return;
  }

  console.log(`[RouteDispatcher] Found ${routes.length} matching routes for ${eventType}`);

  // Dispatch to all routes in parallel
  const results = await Promise.allSettled(
    routes.map(route => dispatchRoute(route, enrichedData))
  );

  // Log any failures
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`[RouteDispatcher] Route ${routes[index].id} failed:`, result.reason);
    }
  });
}

/**
 * Dispatch to a single route
 * @param {Object} route - Route configuration
 * @param {Object} eventData - Event data
 * @param {number|null} existingLogId - Existing log ID for retries
 * @returns {Object} Dispatch result
 */
export async function dispatchRoute(route, eventData, existingLogId = null) {
  const deliveryId = `del_${crypto.randomBytes(8).toString('hex')}`;
  const startTime = Date.now();

  // Build payload
  const payload = buildPayload(route, eventData, deliveryId);

  const deliverableId = eventData.deliverable?.id || null;

  // Create or update delivery log
  let logId = existingLogId;
  if (!logId) {
    const logResult = db.prepare(`
      INSERT INTO delivery_logs (route_id, event_type, event_payload, status, deliverable_id)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(route.id, route.trigger_event, JSON.stringify(eventData), deliverableId);
    logId = logResult.lastInsertRowid;
  } else {
    // Update attempt number for retry
    db.prepare(`
      UPDATE delivery_logs
      SET attempt_number = attempt_number + 1, status = 'retrying'
      WHERE id = ?
    `).run(logId);
  }

  try {
    let result;

    if (route.destination_type === 'webhook') {
      result = await deliverWebhook(route.destination_config, payload);
    } else if (route.destination_type === 'email') {
      result = await deliverEmail(route.destination_config, eventData, route.field_mapping);
    } else if (route.destination_type === 'storage') {
      result = await deliverStorage(route.destination_config, eventData);
    } else if (route.destination_type === 'slack') {
      result = await sendSlackMessage(route.destination_config, eventData);
    } else {
      throw new Error(`Unsupported destination type: ${route.destination_type}`);
    }

    const duration = Date.now() - startTime;

    // Update log with success
    db.prepare(`
      UPDATE delivery_logs
      SET status = 'delivered',
          response_status = ?,
          response_body = ?,
          completed_at = datetime('now'),
          duration_ms = ?
      WHERE id = ?
    `).run(result.status || 200, truncate(result.body, 50000), duration, logId);

    // Log activity for deliverable route dispatch
    if (deliverableId) {
      logActivity('deliverable', deliverableId, 'route_dispatched', 'system', {
        route_name: route.name, destination_type: route.destination_type, status: 'delivered'
      });
    }

    return { success: true, response: result };
  } catch (error) {
    const duration = Date.now() - startTime;

    // Check retry policy
    const log = db.prepare('SELECT attempt_number FROM delivery_logs WHERE id = ?').get(logId);
    const retryPolicy = route.retry_policy || { max_retries: 3, backoff_type: 'exponential', initial_delay_ms: 1000 };

    if (log.attempt_number < retryPolicy.max_retries) {
      // Schedule durable retry via DB (survives process restarts)
      // Use SQLite datetime format (no T/Z) so comparisons with datetime('now') work
      const delay = calculateBackoff(retryPolicy, log.attempt_number);
      const retryDate = new Date(Date.now() + delay);
      const nextRetryAt = retryDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      db.prepare(`
        UPDATE delivery_logs
        SET status = 'retrying',
            error_message = ?,
            duration_ms = ?,
            next_retry_at = ?
        WHERE id = ?
      `).run(error.message, duration, nextRetryAt, logId);

      return { success: false, error: error.message, retrying: true };
    } else {
      // Final failure
      db.prepare(`
        UPDATE delivery_logs
        SET status = 'failed',
            error_message = ?,
            completed_at = datetime('now'),
            duration_ms = ?
        WHERE id = ?
      `).run(error.message, duration, logId);

      // Log failed dispatch activity
      if (deliverableId) {
        logActivity('deliverable', deliverableId, 'route_dispatched', 'system', {
          route_name: route.name, destination_type: route.destination_type, status: 'failed', error: error.message
        });
      }

      return { success: false, error: error.message, retrying: false };
    }
  }
}

/**
 * Test a route with a payload (no retry logic)
 */
export async function testRoute(route, testPayload) {
  try {
    const payload = buildPayload(route, testPayload, testPayload.delivery_id);

    let result;
    if (route.destination_type === 'webhook') {
      result = await deliverWebhook(route.destination_config, payload);
    } else if (route.destination_type === 'email') {
      result = await deliverEmail(route.destination_config, testPayload, route.field_mapping);
    } else if (route.destination_type === 'storage') {
      // For storage test, just verify the connection
      const storageConfig = resolveStorageConfig(route.destination_config);
      const connResult = await testS3Connection(storageConfig);
      if (!connResult.success) {
        return { success: false, error: connResult.message, detail: connResult.detail };
      }
      result = { status: 200, body: JSON.stringify(connResult) };
    } else if (route.destination_type === 'slack') {
      const connResult = await testSlackConnection(route.destination_config);
      if (!connResult.success) {
        return { success: false, error: connResult.message, detail: connResult.detail };
      }
      result = { status: 200, body: JSON.stringify(connResult) };
    } else {
      throw new Error(`Unsupported destination type: ${route.destination_type}`);
    }

    return { success: true, response: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================
// Webhook Delivery
// ============================================

async function deliverWebhook(config, payload) {
  const { url, method, headers, signing_secret, timeout_ms } = config;

  // SSRF protection: validate URL against private IP ranges
  const urlCheck = await validateWebhookUrl(url);
  if (!urlCheck.valid) {
    throw new Error(`SSRF blocked: ${urlCheck.reason}`);
  }

  const requestHeaders = {
    'Content-Type': 'application/json',
    'User-Agent': 'Cavendo-Engine/1.0',
    ...(headers || {})
  };

  // Add HMAC signature if signing secret is configured
  if (signing_secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', signing_secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    requestHeaders['X-Cavendo-Signature'] = signature;
    requestHeaders['X-Cavendo-Timestamp'] = timestamp.toString();
    requestHeaders['X-Cavendo-Delivery-Id'] = payload.delivery_id;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout_ms || 10000);

  try {
    const response = await fetch(url, {
      method: method || 'POST',
      headers: requestHeaders,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'manual'
    });

    clearTimeout(timeoutId);

    const body = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body.substring(0, 5000)}`);
    }

    return { status: response.status, body };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout_ms || 10000}ms`);
    }
    throw error;
  }
}

// ============================================
// Email Delivery
// ============================================

async function deliverEmail(config, eventData, fieldMapping) {
  if (!isEmailConfigured()) {
    throw new Error('Email provider not configured. Set EMAIL_PROVIDER environment variable.');
  }

  const {
    to,
    cc,
    from_name,
    from_address,
    subject_template,
    template,
    include_content_preview,
    attach_files,
    reply_to
  } = config;

  // Resolve Handlebars templates in recipient fields (e.g., {{assignee.email}})
  const templateContext = { ...eventData, event_label: formatEventLabel(eventData.event) };
  const resolvedTo = resolveEmailRecipients(to, templateContext);
  const resolvedCc = resolveEmailRecipients(cc, templateContext);

  if (!resolvedTo || resolvedTo.length === 0) {
    throw new Error('No valid email recipients after template resolution');
  }

  // Build subject using template
  let subject = 'Notification from Cavendo';
  if (subject_template) {
    try {
      const compiled = Handlebars.compile(subject_template, { strict: true });
      subject = compiled({
        ...eventData,
        event_label: formatEventLabel(eventData.event)
      }, {
        allowProtoMethodsByDefault: false,
        allowProtoPropertiesByDefault: false
      });
    } catch (e) {
      console.warn('[RouteDispatcher] Failed to compile subject template:', e);
      subject = `${formatEventLabel(eventData.event)}: ${eventData.deliverable?.title || 'Notification'}`;
    }
  }

  // Build HTML content
  const html = buildEmailHtml(template || 'default', eventData, include_content_preview);
  const text = buildEmailText(eventData, include_content_preview);

  // Build attachments if enabled
  let attachments = [];
  if (attach_files && eventData.deliverable?.files) {
    attachments = await buildAttachments(eventData.deliverable.files);
  }

  const result = await sendEmail({
    to: resolvedTo,
    cc: resolvedCc,
    from: from_address,
    fromName: from_name,
    subject,
    html,
    text,
    attachments,
    replyTo: reply_to
  });

  return { status: 200, body: JSON.stringify(result) };
}

// ============================================
// Storage Delivery
// ============================================

const CONTENT_TYPE_MAP = {
  markdown: { mime: 'text/markdown', ext: '.md' },
  html: { mime: 'text/html', ext: '.html' },
  json: { mime: 'application/json', ext: '.json' },
  text: { mime: 'text/plain', ext: '.txt' },
  code: { mime: 'text/plain', ext: '.txt' }
};

/**
 * Resolve storage config — if connection_id is set, look up stored connection credentials
 */
function resolveStorageConfig(config) {
  if (!config.connection_id) return config;

  const conn = db.prepare('SELECT * FROM storage_connections WHERE id = ?').get(config.connection_id);
  if (!conn) throw new Error(`Storage connection #${config.connection_id} not found`);

  return {
    ...config,
    provider: conn.provider,
    bucket: conn.bucket,
    region: conn.region,
    endpoint: conn.endpoint,
    access_key_id: decrypt(conn.access_key_id_encrypted, conn.access_key_id_iv),
    secret_access_key: decrypt(conn.secret_access_key_encrypted, conn.secret_access_key_iv)
  };
}

async function deliverStorage(config, eventData) {
  config = resolveStorageConfig(config);
  const deliverable = eventData.deliverable || {};
  const projectName = (eventData.project?.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const deliverableId = deliverable.id || 'unknown';
  const prefix = `${config.path_prefix || ''}${projectName}/${deliverableId}/`;

  const uploaded = [];

  // Upload main content
  if (config.upload_content !== false && deliverable.content) {
    const contentType = deliverable.content_type || 'text';
    const mapping = CONTENT_TYPE_MAP[contentType] || CONTENT_TYPE_MAP.text;
    const key = `${prefix}content${mapping.ext}`;

    const result = await uploadToS3(config, key, deliverable.content, mapping.mime);
    uploaded.push(result.key);
  }

  // Upload file attachments
  if (config.upload_files !== false && deliverable.files) {
    const files = typeof deliverable.files === 'string'
      ? safeJsonParse(deliverable.files, [])
      : deliverable.files;

    const dataDir = path.resolve(process.cwd(), 'data');

    for (const file of files) {
      if (!file.filename) continue;

      const key = `${prefix}${file.filename}`;
      let body;
      let mime = file.mimeType || 'application/octet-stream';

      if (file.path) {
        // Read from local disk — resolve against data/ directory
        const filePath = path.resolve(dataDir, file.path.replace(/^\//, ''));
        // Path traversal protection: ensure resolved path stays within dataDir
        if (!filePath.startsWith(dataDir + path.sep) && filePath !== dataDir) {
          console.warn(`[RouteDispatcher] Path traversal blocked: ${file.path}`);
          continue;
        }
        try {
          body = fs.readFileSync(filePath);
        } catch (err) {
          console.warn(`[RouteDispatcher] Could not read file ${filePath}: ${err.message}`);
          continue;
        }
      } else if (file.content) {
        // Inline content
        body = file.content;
      } else {
        continue;
      }

      const result = await uploadToS3(config, key, body, mime);
      uploaded.push(result.key);
    }
  }

  if (uploaded.length === 0) {
    throw new Error('No files to upload — deliverable has no content or file attachments');
  }

  return { status: 200, body: JSON.stringify({ uploaded }) };
}

// ============================================
// Payload Building
// ============================================

function buildPayload(route, eventData, deliveryId) {
  const config = route.destination_config || {};

  // If custom payload template is configured, use it (sandboxed)
  if (config.payload_template) {
    try {
      const compiled = Handlebars.compile(config.payload_template, { strict: true });
      const rendered = compiled(eventData, {
        allowProtoMethodsByDefault: false,
        allowProtoPropertiesByDefault: false
      });
      return JSON.parse(rendered);
    } catch (e) {
      console.warn('[RouteDispatcher] Failed to compile payload template:', e);
    }
  }

  // Apply field mapping if configured
  let payload = {
    event: route.trigger_event,
    timestamp: new Date().toISOString(),
    delivery_id: deliveryId,
    ...eventData
  };

  if (route.field_mapping) {
    payload = applyFieldMapping(payload, route.field_mapping);
  }

  return payload;
}

function applyFieldMapping(data, mapping) {
  const result = {};

  for (const [targetField, sourceField] of Object.entries(mapping)) {
    const value = getNestedValue(data, sourceField);
    if (value !== undefined) {
      setNestedValue(result, targetField, value);
    }
  }

  // Include unmapped fields
  return { ...data, ...result };
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  if (keys.some(k => DANGEROUS_KEYS.has(k))) {
    console.warn(`[RouteDispatcher] Blocked dangerous field mapping key: ${path}`);
    return;
  }
  const lastKey = keys.pop();
  const target = keys.reduce((current, key) => {
    if (!current[key]) current[key] = {};
    return current[key];
  }, obj);
  target[lastKey] = value;
}

// ============================================
// Email Templates
// ============================================

function buildEmailHtml(template, eventData, includePreview) {
  const deliverable = eventData.deliverable || {};
  const project = eventData.project || {};
  const eventLabel = formatEventLabel(eventData.event);

  const preview = includePreview && deliverable.content
    ? deliverable.content.substring(0, 500) + (deliverable.content.length > 500 ? '...' : '')
    : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #4F46E5; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; border-top: none; }
    .footer { background: #f3f4f6; padding: 15px; text-align: center; font-size: 12px; color: #6b7280; border-radius: 0 0 8px 8px; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 500; }
    .badge-approved { background: #D1FAE5; color: #065F46; }
    .badge-submitted { background: #DBEAFE; color: #1E40AF; }
    .badge-revision { background: #FEF3C7; color: #92400E; }
    .badge-rejected { background: #FEE2E2; color: #991B1B; }
    .preview { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; margin: 15px 0; white-space: pre-wrap; }
    .button { display: inline-block; background: #4F46E5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; margin-top: 15px; }
    h1 { margin: 0 0 10px 0; font-size: 20px; }
    .meta { color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${escapeHtml(deliverable.title || 'Notification')}</h1>
      <span class="badge badge-${getBadgeClass(eventData.event)}">${escapeHtml(eventLabel)}</span>
    </div>
    <div class="content">
      <p class="meta">
        ${project.name ? `<strong>Project:</strong> ${escapeHtml(project.name)}<br>` : ''}
        ${deliverable.submitted_by?.name ? `<strong>Submitted by:</strong> ${escapeHtml(deliverable.submitted_by.name)}<br>` : ''}
        ${deliverable.approved_by?.name ? `<strong>Reviewed by:</strong> ${escapeHtml(deliverable.approved_by.name)}<br>` : ''}
        <strong>Time:</strong> ${escapeHtml(new Date(eventData.timestamp).toLocaleString())}
      </p>
      ${deliverable.summary ? `<p><strong>Summary:</strong> ${escapeHtml(deliverable.summary)}</p>` : ''}
      ${preview ? `<div class="preview">${escapeHtml(preview)}</div>` : ''}
      ${eventData.feedback ? `<p><strong>Feedback:</strong> ${escapeHtml(eventData.feedback)}</p>` : ''}
    </div>
    <div class="footer">
      Sent by Cavendo Engine
    </div>
  </div>
</body>
</html>
  `;
}

function buildEmailText(eventData, includePreview) {
  const deliverable = eventData.deliverable || {};
  const project = eventData.project || {};
  const eventLabel = formatEventLabel(eventData.event);

  let text = `${eventLabel}: ${deliverable.title || 'Notification'}\n\n`;

  if (project.name) text += `Project: ${project.name}\n`;
  if (deliverable.submitted_by?.name) text += `Submitted by: ${deliverable.submitted_by.name}\n`;
  if (deliverable.approved_by?.name) text += `Reviewed by: ${deliverable.approved_by.name}\n`;
  text += `Time: ${new Date(eventData.timestamp).toLocaleString()}\n\n`;

  if (deliverable.summary) text += `Summary: ${deliverable.summary}\n\n`;

  if (includePreview && deliverable.content) {
    text += `Content Preview:\n${deliverable.content.substring(0, 500)}${deliverable.content.length > 500 ? '...' : ''}\n\n`;
  }

  if (eventData.feedback) text += `Feedback: ${eventData.feedback}\n`;

  text += '\n---\nSent by Cavendo Engine';
  return text;
}

async function buildAttachments(files) {
  // In production, this would read files from storage
  // For now, return empty array (files are stored as paths)
  return [];
}

// ============================================
// Utility Functions
// ============================================

function safeJsonParse(str, defaultValue = null) {
  if (str === null || str === undefined) return defaultValue;
  if (typeof str !== 'string') return str;
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

function formatRoute(route) {
  return {
    ...route,
    trigger_conditions: safeJsonParse(route.trigger_conditions, null),
    destination_config: safeJsonParse(route.destination_config, {}),
    field_mapping: safeJsonParse(route.field_mapping, null),
    retry_policy: safeJsonParse(route.retry_policy, { max_retries: 3, backoff_type: 'exponential', initial_delay_ms: 1000 }),
    enabled: !!route.enabled
  };
}

function calculateBackoff(policy, attempt) {
  const { backoff_type, initial_delay_ms } = policy;

  switch (backoff_type) {
    case 'exponential':
      return initial_delay_ms * Math.pow(2, attempt);
    case 'linear':
      return initial_delay_ms * (attempt + 1);
    case 'fixed':
    default:
      return initial_delay_ms;
  }
}

function truncate(str, maxLength) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

function formatEventLabel(event) {
  const labels = {
    'deliverable.approved': 'Approved',
    'deliverable.submitted': 'New Submission',
    'deliverable.revision_requested': 'Revision Requested',
    'deliverable.rejected': 'Rejected',
    'task.created': 'New Task',
    'task.completed': 'Task Completed',
    'task.status_changed': 'Task Updated',
    'task.assigned': 'Task Assigned',
    'task.updated': 'Task Updated',
    'task.claimed': 'Task Claimed',
    'task.progress_updated': 'Progress Updated',
    'task.overdue': 'Task Overdue',
    'task.routing_failed': 'Routing Failed',
    'task.execution_failed': 'Execution Failed',
    'review.completed': 'Review Complete',
    'agent.registered': 'New Agent',
    'agent.status_changed': 'Agent Status Changed',
    'project.created': 'New Project',
    'project.knowledge_updated': 'Knowledge Updated',
    'knowledge.updated': 'Knowledge Updated'
  };
  return labels[event] || event;
}

function getBadgeClass(event) {
  const classes = {
    'deliverable.approved': 'approved',
    'deliverable.submitted': 'submitted',
    'deliverable.revision_requested': 'revision',
    'deliverable.rejected': 'rejected',
    'task.overdue': 'rejected',
    'task.routing_failed': 'rejected',
    'task.execution_failed': 'rejected'
  };
  return classes[event] || 'submitted';
}

/**
 * Resolve Handlebars templates in email recipient lists.
 * Entries like "{{assignee.email}}" are resolved against the event data.
 * Plain email addresses are passed through unchanged.
 * Resolved values that are empty or not valid emails are filtered out.
 */
function resolveEmailRecipients(recipients, context) {
  if (!recipients) return [];
  const list = Array.isArray(recipients) ? recipients : [recipients];
  const resolved = [];
  for (const entry of list) {
    if (!entry) continue;
    if (entry.includes('{{')) {
      try {
        const compiled = Handlebars.compile(entry, { noEscape: true });
        const result = compiled(context).trim();
        if (result && result.includes('@')) {
          resolved.push(result);
        }
      } catch (e) {
        console.warn(`[RouteDispatcher] Failed to resolve email template "${entry}":`, e.message);
      }
    } else {
      resolved.push(entry.trim());
    }
  }
  return resolved;
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// ============================================
// Durable Retry Sweep
// ============================================

const RETRY_SWEEP_INTERVAL_MS = parseInt(process.env.RETRY_SWEEP_INTERVAL_MS) || 15000;
let retrySweepHandle = null;

/**
 * Sweep for delivery_logs with status='retrying' and next_retry_at <= now,
 * then re-dispatch them. Durable across process restarts.
 */
async function retrySweep() {
  try {
    const due = db.prepare(`
      SELECT dl.*, r.trigger_event, r.destination_type, r.destination_config,
             r.field_mapping, r.retry_policy, r.name as route_name, r.enabled,
             r.trigger_conditions, r.project_id as route_project_id
      FROM delivery_logs dl
      JOIN routes r ON r.id = dl.route_id
      WHERE dl.status = 'retrying'
        AND dl.next_retry_at <= datetime('now')
      ORDER BY dl.next_retry_at ASC
      LIMIT 10
    `).all();

    if (due.length === 0) return;

    console.log(`[RouteDispatcher] Retry sweep: ${due.length} delivery(ies) due`);

    for (const log of due) {
      // Reconstruct route object
      const route = formatRoute({
        id: log.route_id,
        name: log.route_name,
        trigger_event: log.trigger_event,
        destination_type: log.destination_type,
        destination_config: log.destination_config,
        field_mapping: log.field_mapping,
        retry_policy: log.retry_policy,
        trigger_conditions: log.trigger_conditions,
        enabled: log.enabled,
        project_id: log.route_project_id
      });

      // Reconstruct event data from stored payload, enriching assignee if missing
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

      // Clear next_retry_at before dispatching (prevent double-pickup)
      db.prepare('UPDATE delivery_logs SET next_retry_at = NULL WHERE id = ?').run(log.id);

      try {
        await dispatchRoute(route, eventData, log.id);
      } catch (err) {
        console.error(`[RouteDispatcher] Retry failed for log #${log.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[RouteDispatcher] Retry sweep error:', err);
  }
}

/**
 * Start the durable retry sweep loop
 */
export function startRetrySweep() {
  if (retrySweepHandle) return;
  console.log(`[RouteDispatcher] Starting retry sweep — interval ${RETRY_SWEEP_INTERVAL_MS / 1000}s`);
  retrySweepHandle = setInterval(retrySweep, RETRY_SWEEP_INTERVAL_MS);
  // Run once on startup after short delay
  setTimeout(retrySweep, 3000);
}

/**
 * Stop the retry sweep loop
 */
export function stopRetrySweep() {
  if (retrySweepHandle) {
    clearInterval(retrySweepHandle);
    retrySweepHandle = null;
    console.log('[RouteDispatcher] Retry sweep stopped');
  }
}
