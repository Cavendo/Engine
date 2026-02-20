/**
 * Slack Provider
 * Sends formatted messages to Slack via Incoming Webhooks
 * Supports Block Kit rich formatting and simple text messages
 */

import { validateWebhookUrl } from './webhooks.js';

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Validated fetch to a Slack webhook with SSRF protection and timeout
 */
async function safeFetch(url, body, timeoutMs) {
  // SSRF protection: block private/internal targets
  const urlCheck = await validateWebhookUrl(url);
  if (!urlCheck.valid) {
    throw new Error(`SSRF blocked: ${urlCheck.reason}`);
  }

  const controller = new AbortController();
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual'
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`Slack timeout after ${timeout}ms`);
    }
    throw err;
  }
}

/**
 * Send a message to a Slack webhook
 * @param {Object} config - Slack destination config
 * @param {Object} eventData - Event data with deliverable, project, etc.
 * @returns {Promise<{status: number, body: string}>}
 */
export async function sendSlackMessage(config, eventData) {
  const payload = config.message_style === 'simple'
    ? buildSimplePayload(config, eventData)
    : buildRichPayload(config, eventData);

  const response = await safeFetch(config.webhook_url, payload, config.timeout_ms);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Slack API error (HTTP ${response.status}): ${body}`);
  }

  return { status: response.status, body };
}

/**
 * Test a Slack webhook by sending a test message
 * @param {Object} config - Slack destination config
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testSlackConnection(config) {
  try {
    const payload = {
      text: 'Cavendo Engine test message — connection successful!',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':white_check_mark: *Cavendo Engine* — Connection test successful!\nThis Slack webhook is configured correctly.'
          }
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `Sent at ${new Date().toLocaleString()} by Cavendo Engine`
          }]
        }
      ]
    };

    const response = await safeFetch(config.webhook_url, payload, config.timeout_ms);
    const body = await response.text();

    if (!response.ok) {
      return {
        success: false,
        message: `Slack webhook returned HTTP ${response.status}: ${body}`,
        detail: { httpStatus: response.status, body }
      };
    }

    return { success: true, message: 'Slack webhook is working — test message sent' };
  } catch (err) {
    return {
      success: false,
      message: err.message,
      detail: { code: err.code || 'NETWORK_ERROR', message: err.message }
    };
  }
}

// ============================================
// Payload Builders
// ============================================

const EVENT_CONFIG = {
  'deliverable.approved':           { emoji: ':white_check_mark:', color: '#22c55e', label: 'Approved' },
  'deliverable.submitted':          { emoji: ':inbox_tray:',       color: '#3b82f6', label: 'New Submission' },
  'deliverable.revision_requested': { emoji: ':pencil2:',          color: '#f59e0b', label: 'Revision Requested' },
  'deliverable.rejected':           { emoji: ':x:',                color: '#ef4444', label: 'Rejected' },
  'task.created':                   { emoji: ':clipboard:',        color: '#8b5cf6', label: 'New Task' },
  'task.completed':                 { emoji: ':white_check_mark:', color: '#22c55e', label: 'Task Completed' },
  'task.status_changed':            { emoji: ':arrows_counterclockwise:', color: '#6366f1', label: 'Task Updated' },
  'task.routing_failed':            { emoji: ':warning:',          color: '#ef4444', label: 'Routing Failed' },
  'task.execution_failed':          { emoji: ':rotating_light:',   color: '#ef4444', label: 'Execution Failed' },
  'review.completed':               { emoji: ':mag:',              color: '#22c55e', label: 'Review Complete' },
  'agent.registered':               { emoji: ':robot_face:',       color: '#8b5cf6', label: 'New Agent' },
  'agent.status_changed':           { emoji: ':large_blue_circle:', color: '#f59e0b', label: 'Agent Status Changed' },
  'task.assigned':                   { emoji: ':dart:',              color: '#6366f1', label: 'Task Assigned' },
  'task.overdue':                    { emoji: ':alarm_clock:',       color: '#ef4444', label: 'Task Overdue' },
  'project.created':                 { emoji: ':file_folder:',       color: '#3b82f6', label: 'New Project' },
  'knowledge.updated':              { emoji: ':books:',              color: '#10b981', label: 'Knowledge Updated' }
};

function getEventConfig(event) {
  return EVENT_CONFIG[event] || { emoji: ':bell:', color: '#6b7280', label: event };
}

/**
 * Build a simple text-only payload
 */
function buildSimplePayload(config, eventData) {
  const deliverable = eventData.deliverable || {};
  const project = eventData.project || {};
  const ec = getEventConfig(eventData.event);

  let text = `${ec.emoji} *${ec.label}*`;
  if (deliverable.title) text += `: ${deliverable.title}`;
  if (project.name) text += ` (${project.name})`;
  if (deliverable.summary) text += `\n> ${deliverable.summary}`;
  if (eventData.feedback) text += `\n> _Feedback: ${eventData.feedback}_`;

  return { text };
}

/**
 * Build a rich Block Kit payload
 */
function buildRichPayload(config, eventData) {
  const deliverable = eventData.deliverable || {};
  const project = eventData.project || {};
  const task = eventData.task || {};
  const ec = getEventConfig(eventData.event);

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${ec.label}: ${deliverable.title || task.title || 'Notification'}`, emoji: true }
  });

  // Project & meta info
  const metaParts = [];
  if (project.name) metaParts.push(`*Project:* ${project.name}`);
  if (deliverable.submitted_by?.name) metaParts.push(`*By:* ${deliverable.submitted_by.name}`);
  if (deliverable.approved_by?.name) metaParts.push(`*Reviewer:* ${deliverable.approved_by.name}`);
  if (task.status) metaParts.push(`*Status:* ${task.status}`);

  if (metaParts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: metaParts.join('  |  ') }
    });
  }

  // Summary
  if (deliverable.summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: deliverable.summary }
    });
  }

  // Content preview
  if (config.include_content_preview && deliverable.content) {
    const preview = deliverable.content.substring(0, 500) + (deliverable.content.length > 500 ? '...' : '');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '```\n' + preview + '\n```' }
    });
  }

  // Feedback (for revisions)
  if (eventData.feedback) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:speech_balloon: *Feedback:*\n> ${eventData.feedback}` }
    });
  }

  // File attachments list
  if (config.include_files_list && deliverable.files) {
    const files = typeof deliverable.files === 'string' ? safeJsonParse(deliverable.files, []) : (deliverable.files || []);
    if (files.length > 0) {
      const fileList = files.map(f => `• \`${f.filename}\`${f.size ? ` (${formatBytes(f.size)})` : ''}`).join('\n');
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `:file_folder: *Attachments:*\n${fileList}` }
      });
    }
  }

  // Actions list
  if (config.include_actions && deliverable.actions) {
    const actions = typeof deliverable.actions === 'string' ? safeJsonParse(deliverable.actions, []) : (deliverable.actions || []);
    if (actions.length > 0) {
      const actionList = actions.map(a => {
        const time = a.estimated_time_minutes ? ` (~${a.estimated_time_minutes}m)` : '';
        return `• ${a.action_text}${time}`;
      }).join('\n');
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `:arrow_right: *Follow-up Actions:*\n${actionList}` }
      });
    }
  }

  // Divider + footer
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${ec.emoji} ${ec.label} | Cavendo Engine | ${new Date().toLocaleString()}`
    }]
  });

  // Slack requires a top-level `text` as fallback for notifications
  const fallback = `${ec.label}: ${deliverable.title || task.title || 'Notification'}${project.name ? ` (${project.name})` : ''}`;

  return { text: fallback, blocks, unfurl_links: config.unfurl_links !== true ? false : true };
}

// ============================================
// Utilities
// ============================================

function safeJsonParse(str, defaultValue) {
  if (!str || typeof str !== 'string') return defaultValue;
  try { return JSON.parse(str); } catch { return defaultValue; }
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
