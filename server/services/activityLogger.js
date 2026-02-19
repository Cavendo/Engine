/**
 * Activity Logger Service
 * Logs lifecycle events for deliverables and tasks into the activity_log table.
 * All calls are fire-and-forget — they should never block the main response.
 */

import db from '../db/connection.js';

/**
 * Log an activity event
 * @param {string} entityType - 'deliverable' or 'task'
 * @param {number} entityId - The entity's ID
 * @param {string} eventType - Event type (e.g. 'status_changed', 'created')
 * @param {string} actorName - Who performed the action
 * @param {object} detail - JSON-serializable context
 */
export function logActivity(entityType, entityId, eventType, actorName, detail = {}) {
  try {
    db.prepare(
      `INSERT INTO activity_log (entity_type, entity_id, event_type, actor_name, detail) VALUES (?, ?, ?, ?, ?)`
    ).run(entityType, entityId, eventType, actorName || 'system', JSON.stringify(detail));
  } catch (err) {
    console.error('[ActivityLogger] Failed to log activity:', err.message);
  }
}
