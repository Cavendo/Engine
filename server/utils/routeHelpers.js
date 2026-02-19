/**
 * Route helper functions for sanitization and formatting
 * Extracted for testability without heavy dependencies
 */

/**
 * Normalize SQLite timestamps to ISO 8601 format
 */
function toISOTimestamp(timestamp) {
  if (!timestamp) return null;
  if (timestamp.includes('T')) return timestamp;
  return timestamp.replace(' ', 'T') + '.000Z';
}

/**
 * Safely parse JSON with fallback
 * @param {string} str - JSON string to parse
 * @param {any} defaultValue - Default value if parsing fails
 * @returns {any} Parsed value or default
 */
export function safeJsonParse(str, defaultValue = null) {
  if (str === null || str === undefined) return defaultValue;
  if (typeof str !== 'string') return str; // already parsed
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

/**
 * Sanitize a URL to remove embedded credentials (userinfo).
 * Example: https://user:pass@example.com → https://[REDACTED]@example.com
 * @param {string} urlString - The URL to sanitize
 * @returns {string} Sanitized URL or original if parsing fails
 */
export function sanitizeUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return urlString;

  try {
    const url = new URL(urlString);
    // Check if URL has embedded credentials
    if (url.username || url.password) {
      url.username = '[REDACTED]';
      url.password = '';
      return url.toString();
    }
    return urlString;
  } catch {
    // If URL parsing fails, return original (may not be a valid URL)
    return urlString;
  }
}

/**
 * Sanitize destination_config to remove sensitive fields for non-admin users.
 * Admins see the full config; other users see redacted versions.
 * @param {object} config - The destination configuration object
 * @param {string} destinationType - 'webhook' or 'email'
 * @param {boolean} isAdmin - Whether the requesting user is an admin
 * @returns {object} Sanitized config
 */
export function sanitizeDestinationConfig(config, destinationType, isAdmin) {
  if (!config) return config;
  if (isAdmin) return config;

  const sanitized = { ...config };

  if (destinationType === 'webhook') {
    // Redact embedded credentials in URL (e.g., https://user:pass@example.com)
    if (sanitized.url) {
      sanitized.url = sanitizeUrl(sanitized.url);
    }
    // Redact signing_secret
    if (sanitized.signing_secret) {
      sanitized.signing_secret = '[REDACTED]';
    }
    // Redact header values (keep keys visible for debugging)
    if (sanitized.headers && typeof sanitized.headers === 'object') {
      const redactedHeaders = {};
      for (const key of Object.keys(sanitized.headers)) {
        redactedHeaders[key] = '[REDACTED]';
      }
      sanitized.headers = redactedHeaders;
    }
  } else if (destinationType === 'email') {
    // Redact any API keys or credentials in email config
    // Currently email config doesn't contain secrets, but future-proof it
    const sensitiveKeys = ['api_key', 'apiKey', 'password', 'secret', 'credentials'];
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
        sanitized[key] = '[REDACTED]';
      }
    }
  } else if (destinationType === 'storage') {
    if (sanitized.connection_id) {
      // Using stored connection — no inline credentials to redact
      delete sanitized.secret_access_key;
      delete sanitized.access_key_id;
    } else {
      if (sanitized.secret_access_key) {
        sanitized.secret_access_key = '[REDACTED]';
      }
      if (sanitized.access_key_id) {
        sanitized.access_key_id = '...' + sanitized.access_key_id.slice(-4);
      }
    }
    if (sanitized.endpoint) {
      sanitized.endpoint = sanitizeUrl(sanitized.endpoint);
    }
  } else if (destinationType === 'slack') {
    if (sanitized.webhook_url) {
      // Show domain but redact the path (contains the secret token)
      try {
        const url = new URL(sanitized.webhook_url);
        sanitized.webhook_url = `${url.origin}/services/[REDACTED]`;
      } catch {
        sanitized.webhook_url = '[REDACTED]';
      }
    }
  }

  return sanitized;
}

/**
 * Format delivery log for API response
 * @param {Object} log - Raw log from database
 * @param {boolean} isAdmin - If true, show full payloads; if false, show summary only
 * @returns {Object} Formatted log
 */
export function formatDeliveryLog(log, isAdmin = false) {
  const payload = safeJsonParse(log.event_payload, {});

  // For non-admins, only show metadata, not full content
  const sanitizedPayload = isAdmin ? payload : {
    event: payload.event,
    timestamp: payload.timestamp,
    project: payload.project,
    deliverable: payload.deliverable ? {
      id: payload.deliverable.id,
      title: payload.deliverable.title,
      status: payload.deliverable.status
      // Omit content, summary, files for non-admins
    } : undefined,
    task: payload.task ? {
      id: payload.task.id,
      title: payload.task.title,
      status: payload.task.status
      // Omit description, context for non-admins
    } : undefined
  };

  return {
    id: log.id,
    route_id: log.route_id,
    event_type: log.event_type,
    status: log.status,
    attempt_number: log.attempt_number,
    response_status: log.response_status,
    // Only show response body to admins (may contain sensitive error details)
    response_body: isAdmin ? log.response_body : (log.response_body ? '[HIDDEN]' : null),
    // Only show error message to admins (may leak downstream secrets/tokens in error responses)
    error_message: isAdmin ? log.error_message : (log.error_message ? '[HIDDEN]' : null),
    dispatched_at: toISOTimestamp(log.dispatched_at),
    completed_at: toISOTimestamp(log.completed_at),
    duration_ms: log.duration_ms,
    event_payload: sanitizedPayload
  };
}
