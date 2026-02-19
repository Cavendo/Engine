import { URL } from 'url';
import dns from 'dns/promises';
import db from '../db/connection.js';
import { generateWebhookSignature } from '../utils/crypto.js';

function safeJsonParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

const WEBHOOK_TIMEOUT = parseInt(process.env.WEBHOOK_TIMEOUT_MS) || 5000;
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES) || 3;

// Webhook loop protection
const WEBHOOK_LOOP_WINDOW = 60000; // 1 minute
const MAX_WEBHOOKS_PER_WINDOW = 100;
const webhookCounts = new Map(); // agentId:event -> count

// Private IP ranges to block for SSRF protection
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^localhost$/i,
];

/**
 * Validate webhook URL for SSRF protection
 * In development/testing, set ALLOW_PRIVATE_WEBHOOKS=true to allow localhost URLs
 * @param {string} urlString - The URL to validate
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateWebhookUrl(urlString) {
  try {
    const url = new URL(urlString);

    // Only allow http and https
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, reason: 'Only HTTP(S) URLs are allowed' };
    }

    // Skip SSRF checks when explicitly allowed (development/testing)
    if (process.env.ALLOW_PRIVATE_WEBHOOKS === 'true') {
      return { valid: true };
    }

    // Check hostname against private patterns
    const hostname = url.hostname.toLowerCase();
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return { valid: false, reason: 'Private/internal URLs are not allowed' };
      }
    }

    // Resolve hostname and check IP
    try {
      const addresses = await dns.resolve4(hostname);
      for (const ip of addresses) {
        for (const pattern of PRIVATE_IP_PATTERNS) {
          if (pattern.test(ip)) {
            return { valid: false, reason: 'URL resolves to private IP' };
          }
        }
      }
    } catch {
      // DNS resolution failed - could be internal hostname
      return { valid: false, reason: 'Could not resolve hostname' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
}

/**
 * Check for webhook loops
 * @param {number} agentId - The agent ID
 * @param {string} eventType - The event type
 * @returns {boolean} - True if loop detected
 */
function checkWebhookLoop(agentId, eventType) {
  const key = `${agentId}:${eventType}`;
  const now = Date.now();

  // Clean old entries
  for (const [k, v] of webhookCounts.entries()) {
    if (now - v.timestamp > WEBHOOK_LOOP_WINDOW) {
      webhookCounts.delete(k);
    }
  }

  const entry = webhookCounts.get(key);
  if (entry && now - entry.timestamp < WEBHOOK_LOOP_WINDOW) {
    if (entry.count >= MAX_WEBHOOKS_PER_WINDOW) {
      console.warn(`[Webhook] Loop detected for agent ${agentId}, event ${eventType}`);
      return true; // Loop detected
    }
    entry.count++;
  } else {
    webhookCounts.set(key, { count: 1, timestamp: now });
  }

  return false;
}

/**
 * Trigger a webhook for a specific agent and event
 * @param {number} agentId - The agent ID
 * @param {string} eventType - The event type (e.g., 'task.assigned')
 * @param {object} payload - The event payload
 */
export async function triggerWebhook(agentId, eventType, payload) {
  // Check for webhook loops
  if (checkWebhookLoop(agentId, eventType)) {
    console.warn(`[Webhook] Skipping due to rate limit: ${agentId}:${eventType}`);
    return;
  }

  try {
    // Find all active webhooks for this agent that subscribe to this event
    const webhooks = db.prepare(`
      SELECT id, url, secret, events
      FROM webhooks
      WHERE agent_id = ? AND status = 'active'
    `).all(agentId);

    // Also check agent's inline webhook config
    const agent = db.prepare(`
      SELECT webhook_url, webhook_secret, webhook_events
      FROM agents
      WHERE id = ? AND webhook_url IS NOT NULL
    `).get(agentId);

    const targets = [];

    // Add explicit webhooks
    for (const webhook of webhooks) {
      const events = safeJsonParse(webhook.events, []);
      if (events.includes(eventType) || events.includes('*')) {
        targets.push({
          webhookId: webhook.id,
          url: webhook.url,
          secret: webhook.secret
        });
      }
    }

    // Add agent's inline webhook
    if (agent?.webhook_url) {
      const events = safeJsonParse(agent.webhook_events, []);
      if (events.includes(eventType) || events.includes('*') || events.length === 0) {
        targets.push({
          webhookId: null, // Inline webhook
          url: agent.webhook_url,
          secret: agent.webhook_secret
        });
      }
    }

    // Queue deliveries for each target
    for (const target of targets) {
      const fullPayload = {
        event: eventType,
        timestamp: new Date().toISOString(),
        data: payload
      };

      const payloadString = JSON.stringify(fullPayload);

      // Create delivery record
      // For inline webhooks (webhookId is null), store agent_id for tracking
      const result = db.prepare(`
        INSERT INTO webhook_deliveries (webhook_id, agent_id, event_type, payload, status)
        VALUES (?, ?, ?, ?, 'pending')
      `).run(target.webhookId, target.webhookId ? null : agentId, eventType, payloadString);

      // Attempt delivery asynchronously
      deliverWebhook(result.lastInsertRowid, target.url, target.secret, payloadString)
        .catch(err => console.error('Webhook delivery failed:', err));
    }
  } catch (err) {
    console.error('Error triggering webhook:', err);
  }
}

/**
 * Trigger webhooks for all agents assigned to tasks in a project
 * @param {number} projectId - The project ID
 * @param {string} eventType - The event type
 * @param {object} payload - The event payload
 */
export async function triggerWebhookForProject(projectId, eventType, payload) {
  try {
    // Find all agents with tasks in this project
    const agents = db.prepare(`
      SELECT DISTINCT assigned_agent_id as agent_id
      FROM tasks
      WHERE project_id = ? AND assigned_agent_id IS NOT NULL
    `).all(projectId);

    for (const { agent_id } of agents) {
      await triggerWebhook(agent_id, eventType, payload);
    }
  } catch (err) {
    console.error('Error triggering project webhook:', err);
  }
}

/**
 * Deliver a webhook with retry logic
 * @param {number} deliveryId - The delivery record ID
 * @param {string} url - The webhook URL (optional, will be fetched if not provided)
 * @param {string} secret - The webhook secret (optional)
 * @param {string} payload - The JSON payload (optional)
 */
export async function deliverWebhook(deliveryId, url, secret, payload) {
  // Fetch delivery record if not all params provided
  if (!url || !payload) {
    const delivery = db.prepare(`
      SELECT d.*, w.url, w.secret
      FROM webhook_deliveries d
      LEFT JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.id = ?
    `).get(deliveryId);

    if (!delivery) {
      throw new Error('Delivery not found');
    }

    url = url || delivery.url;
    secret = secret || delivery.secret;
    payload = payload || delivery.payload;
  }

  // Get current attempt count
  const delivery = db.prepare('SELECT attempts FROM webhook_deliveries WHERE id = ?').get(deliveryId);
  const attempts = (delivery?.attempts || 0) + 1;

  // Update attempt info
  db.prepare(`
    UPDATE webhook_deliveries
    SET attempts = ?, last_attempt_at = datetime('now')
    WHERE id = ?
  `).run(attempts, deliveryId);

  try {
    // SSRF protection: validate URL at delivery time (not just creation time)
    const urlCheck = await validateWebhookUrl(url);
    if (!urlCheck.valid) {
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'failed', error = ?
        WHERE id = ?
      `).run(`SSRF blocked: ${urlCheck.reason}`, deliveryId);
      return { success: false, error: `SSRF blocked: ${urlCheck.reason}` };
    }

    // Generate signature
    const signature = secret ? generateWebhookSignature(payload, secret) : null;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Cavendo-Engine/0.1.0',
      'X-Cavendo-Event': safeJsonParse(payload, {}).event || 'unknown',
      'X-Cavendo-Delivery': deliveryId.toString(),
      'X-Cavendo-Timestamp': new Date().toISOString()
    };

    if (signature) {
      headers['X-Cavendo-Signature'] = `sha256=${signature}`;
    }

    // Make the request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const responseBody = await response.text().catch(() => '');

    if (response.ok) {
      // Success
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'delivered', response_status = ?, response_body = ?
        WHERE id = ?
      `).run(response.status, responseBody.substring(0, 1000), deliveryId);

      return { success: true, status: response.status };
    } else {
      // Non-2xx response
      throw new Error(`HTTP ${response.status}: ${responseBody.substring(0, 200)}`);
    }
  } catch (err) {
    const errorMessage = err.name === 'AbortError' ? 'Request timeout' : err.message;

    // Check if we should retry
    if (attempts < MAX_RETRIES) {
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'pending', error = ?
        WHERE id = ?
      `).run(errorMessage, deliveryId);

      // Schedule retry with exponential backoff
      const delay = Math.pow(2, attempts) * 1000; // 2s, 4s, 8s
      setTimeout(() => {
        deliverWebhook(deliveryId, url, secret, payload)
          .catch(e => console.error('Retry failed:', e));
      }, delay);

      return { success: false, willRetry: true, attempts, error: errorMessage };
    } else {
      // Max retries reached
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'failed', error = ?
        WHERE id = ?
      `).run(errorMessage, deliveryId);

      return { success: false, willRetry: false, attempts, error: errorMessage };
    }
  }
}

/**
 * Process pending webhook deliveries (for recovery after restart)
 */
export async function processPendingDeliveries() {
  // Fetch pending deliveries from explicit webhooks
  const explicitWebhooks = db.prepare(`
    SELECT d.id, d.payload, w.url, w.secret
    FROM webhook_deliveries d
    JOIN webhooks w ON w.id = d.webhook_id
    WHERE d.status = 'pending' AND d.attempts < ?
    ORDER BY d.created_at ASC
    LIMIT 100
  `).all(MAX_RETRIES);

  // Fetch pending deliveries from inline agent webhooks
  // These have webhook_id = NULL but agent_id is set
  const inlineWebhooks = db.prepare(`
    SELECT d.id, d.payload, a.webhook_url as url, a.webhook_secret as secret
    FROM webhook_deliveries d
    JOIN agents a ON a.id = d.agent_id
    WHERE d.webhook_id IS NULL
      AND d.agent_id IS NOT NULL
      AND d.status = 'pending'
      AND d.attempts < ?
      AND a.webhook_url IS NOT NULL
    ORDER BY d.created_at ASC
    LIMIT 100
  `).all(MAX_RETRIES);

  const pending = [...explicitWebhooks, ...inlineWebhooks];

  console.log(`Processing ${pending.length} pending webhook deliveries (${explicitWebhooks.length} explicit, ${inlineWebhooks.length} inline)`);

  for (const delivery of pending) {
    deliverWebhook(delivery.id, delivery.url, delivery.secret, delivery.payload)
      .catch(err => console.error('Failed to process pending delivery:', err));
  }
}
