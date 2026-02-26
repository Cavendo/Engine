import { Router } from 'express';
import db from '../db/adapter.js';
import { generateUserKey, hashApiKey, getUserKeyPrefix, hashPassword } from '../utils/crypto.js';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { keyGenLimiter } from '../middleware/security.js';
import { dispatchEvent } from '../services/routeDispatcher.js';
import { validateBody, createUserKeySchema, updateUserKeySchema, createUserSchema, updateUserSchema } from '../utils/validation.js';

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
 * Normalize timestamp fields on a user object
 */
function normalizeUserTimestamps(user) {
  return {
    ...user,
    created_at: toISOTimestamp(user.created_at),
    updated_at: toISOTimestamp(user.updated_at),
    last_login_at: toISOTimestamp(user.last_login_at)
  };
}

/**
 * Normalize timestamp fields on a user key object
 */
function normalizeKeyTimestamps(key) {
  return {
    ...key,
    created_at: toISOTimestamp(key.created_at),
    last_used_at: toISOTimestamp(key.last_used_at)
  };
}

// ============================================
// User Personal API Keys
// ============================================

/**
 * GET /api/users/me/keys
 * List current user's API keys (prefix only, not full key)
 */
router.get('/me/keys', userAuth, async (req, res) => {
  try {
    const keys = await db.many(`
      SELECT id, key_prefix, name, last_used_at, created_at
      FROM user_keys
      WHERE user_id = ?
      ORDER BY created_at DESC
    `, [req.user.id]);

    response.success(res, keys.map(key => ({
      id: key.id,
      prefix: key.key_prefix,
      name: key.name,
      lastUsedAt: toISOTimestamp(key.last_used_at),
      createdAt: toISOTimestamp(key.created_at)
    })));
  } catch (err) {
    console.error('Error fetching user keys:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/users/me/keys
 * Generate a new personal API key
 */
router.post('/me/keys', userAuth, keyGenLimiter, validateBody(createUserKeySchema), async (req, res) => {
  try {
    const { name } = req.body;

    const { key, hash, prefix } = generateUserKey();

    const { lastInsertRowid: id } = await db.insert(`
      INSERT INTO user_keys (user_id, key_hash, key_prefix, name)
      VALUES (?, ?, ?, ?)
    `, [req.user.id, hash, prefix, name || null]);

    // Return the key once - it cannot be retrieved again
    response.created(res, {
      id: id,
      apiKey: key, // Only time the full key is returned
      prefix: prefix,
      name: name || null,
      warning: 'Store this key securely - it cannot be retrieved again'
    });
  } catch (err) {
    console.error('Error generating user key:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/users/me/keys/:keyId
 * Update key name
 */
router.patch('/me/keys/:keyId', userAuth, validateBody(updateUserKeySchema), async (req, res) => {
  try {
    // Verify key exists and belongs to this user
    const key = await db.one(`
      SELECT id FROM user_keys WHERE id = ? AND user_id = ?
    `, [req.params.keyId, req.user.id]);

    if (!key) {
      return response.notFound(res, 'API key');
    }

    const { name } = req.body;

    await db.exec(`
      UPDATE user_keys SET name = ? WHERE id = ?
    `, [name, req.params.keyId]);

    response.success(res, { updated: true });
  } catch (err) {
    console.error('Error updating user key:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/users/me/keys/:keyId
 * Revoke a personal API key
 */
router.delete('/me/keys/:keyId', userAuth, async (req, res) => {
  try {
    // Verify key exists and belongs to this user
    const key = await db.one(`
      SELECT id FROM user_keys WHERE id = ? AND user_id = ?
    `, [req.params.keyId, req.user.id]);

    if (!key) {
      return response.notFound(res, 'API key');
    }

    await db.exec(`
      DELETE FROM user_keys WHERE id = ?
    `, [req.params.keyId]);

    response.success(res, { revoked: true });
  } catch (err) {
    console.error('Error revoking user key:', err);
    response.serverError(res);
  }
});

// ============================================
// User Management (Admin)
// ============================================

/**
 * GET /api/users
 * List all users (admin only)
 * Includes linked agent info for each user
 */
router.get('/', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const users = await db.many(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at, u.updated_at,
        a.id as linked_agent_id, a.name as linked_agent_name, a.status as linked_agent_status
      FROM users u
      LEFT JOIN agents a ON a.owner_user_id = u.id AND a.execution_mode = 'human'
      ORDER BY u.created_at DESC
    `, []);

    response.success(res, users.map(u => ({
      ...normalizeUserTimestamps(u),
      linked_agent_id: u.linked_agent_id || null,
      linked_agent_name: u.linked_agent_name || null,
      linked_agent_status: u.linked_agent_status || null
    })));
  } catch (err) {
    console.error('Error listing users:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/users/me
 * Get current user's profile
 */
router.get('/me', userAuth, async (req, res) => {
  try {
    const user = await db.one(`
      SELECT id, email, name, role, status, last_login_at, created_at
      FROM users WHERE id = ?
    `, [req.user.id]);

    if (!user) {
      return response.notFound(res, 'User');
    }

    response.success(res, normalizeUserTimestamps(user));
  } catch (err) {
    console.error('Error getting user profile:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/users
 * Create a new user (admin only)
 * Auto-creates a linked human agent so the user appears as a task assignee
 */
router.post('/', userAuth, requireRoles('admin'), validateBody(createUserSchema), async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    // Check for duplicate email
    const existing = await db.one('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) {
      return response.error(res, 'A user with this email already exists', 409, 'DUPLICATE_EMAIL');
    }

    const passwordHash = await hashPassword(password);

    // Create user + linked human agent in a transaction
    const result = await db.tx(async (tx) => {
      const { lastInsertRowid: userId } = await tx.insert(`
        INSERT INTO users (email, password_hash, name, role)
        VALUES (?, ?, ?, ?)
      `, [email.toLowerCase(), passwordHash, name || null, role || 'reviewer']);

      // Auto-create linked human agent
      const { lastInsertRowid: agentId } = await tx.insert(`
        INSERT INTO agents (name, type, description, capabilities, execution_mode, owner_user_id, status)
        VALUES (?, 'supervised', ?, '[]', 'human', ?, 'active')
      `, [
        name || email.split('@')[0],
        `Linked agent for user ${name || email}`,
        userId
      ]);

      return { userId, agentId };
    });

    const user = await db.one(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.updated_at,
        a.id as linked_agent_id, a.name as linked_agent_name
      FROM users u
      LEFT JOIN agents a ON a.owner_user_id = u.id AND a.execution_mode = 'human'
      WHERE u.id = ?
    `, [result.userId]);

    // Dispatch agent.registered event for the auto-created linked agent
    dispatchEvent('agent.registered', {
      agent: {
        id: result.agentId,
        name: user.linked_agent_name,
        type: 'supervised',
        execution_mode: 'human',
        status: 'active',
        owner_user_id: result.userId
      },
      linkedUser: {
        id: result.userId,
        email: email.toLowerCase(),
        name: name || null,
        role: role || 'reviewer'
      },
      timestamp: new Date().toISOString()
    }).catch(err => console.error('[Users] Route dispatch error:', err));

    response.created(res, {
      ...normalizeUserTimestamps(user),
      linked_agent_id: user.linked_agent_id,
      linked_agent_name: user.linked_agent_name
    });
  } catch (err) {
    console.error('Error creating user:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/users/:id
 * Get a specific user (admin only)
 */
router.get('/:id', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const user = await db.one(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at, u.updated_at,
        a.id as linked_agent_id, a.name as linked_agent_name, a.status as linked_agent_status
      FROM users u
      LEFT JOIN agents a ON a.owner_user_id = u.id AND a.execution_mode = 'human'
      WHERE u.id = ?
    `, [req.params.id]);

    if (!user) {
      return response.notFound(res, 'User');
    }

    response.success(res, {
      ...normalizeUserTimestamps(user),
      linked_agent_id: user.linked_agent_id || null,
      linked_agent_name: user.linked_agent_name || null,
      linked_agent_status: user.linked_agent_status || null
    });
  } catch (err) {
    console.error('Error getting user:', err);
    response.serverError(res);
  }
});

/**
 * PATCH /api/users/:id
 * Update a user (admin only)
 * Cascades status changes to linked human agent
 */
router.patch('/:id', userAuth, requireRoles('admin'), validateBody(updateUserSchema), async (req, res) => {
  try {
    const user = await db.one('SELECT id, email FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return response.notFound(res, 'User');
    }

    const { email, name, role, status } = req.body;

    const updates = [];
    const values = [];

    if (email !== undefined) {
      // Check for duplicate
      const existing = await db.one('SELECT id FROM users WHERE email = ? AND id != ?', [email.toLowerCase(), req.params.id]);
      if (existing) {
        return response.error(res, 'A user with this email already exists', 409, 'DUPLICATE_EMAIL');
      }
      updates.push('email = ?');
      values.push(email.toLowerCase());
    }

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }

    if (role !== undefined) {
      updates.push('role = ?');
      values.push(role);
    }

    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    await db.tx(async (tx) => {
      await tx.exec(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

      // Cascade status to linked human agent
      if (status !== undefined) {
        const agentStatus = status === 'active' ? 'active' : 'disabled';
        await tx.exec(`
          UPDATE agents SET status = ?, updated_at = datetime('now')
          WHERE owner_user_id = ? AND execution_mode = 'human'
        `, [agentStatus, req.params.id]);
      }

      // Cascade name to linked agent
      if (name !== undefined) {
        await tx.exec(`
          UPDATE agents SET name = ?, updated_at = datetime('now')
          WHERE owner_user_id = ? AND execution_mode = 'human'
        `, [name, req.params.id]);
      }
    });

    const updated = await db.one(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at, u.updated_at,
        a.id as linked_agent_id, a.name as linked_agent_name, a.status as linked_agent_status
      FROM users u
      LEFT JOIN agents a ON a.owner_user_id = u.id AND a.execution_mode = 'human'
      WHERE u.id = ?
    `, [req.params.id]);

    response.success(res, {
      ...normalizeUserTimestamps(updated),
      linked_agent_id: updated.linked_agent_id || null,
      linked_agent_name: updated.linked_agent_name || null,
      linked_agent_status: updated.linked_agent_status || null
    });
  } catch (err) {
    console.error('Error updating user:', err);
    response.serverError(res);
  }
});

/**
 * DELETE /api/users/:id
 * Delete a user and their linked human agent (admin only)
 * Cannot delete yourself
 */
router.delete('/:id', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    if (userId === req.user.id) {
      return response.error(res, 'Cannot delete your own account', 400, 'SELF_DELETE');
    }

    const user = await db.one('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) {
      return response.notFound(res, 'User');
    }

    await db.tx(async (tx) => {
      // Delete linked human agent (cascade handles agent_keys, agent_activity)
      await tx.exec(`
        DELETE FROM agents WHERE owner_user_id = ? AND execution_mode = 'human'
      `, [userId]);

      // Delete user (cascade handles sessions, user_keys)
      await tx.exec('DELETE FROM users WHERE id = ?', [userId]);
    });

    response.success(res, { deleted: true });
  } catch (err) {
    console.error('Error deleting user:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/users/:id/reset-password
 * Admin resets a user's password
 */
router.post('/:id/reset-password', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const user = await db.one('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return response.notFound(res, 'User');
    }

    const { password } = req.body;
    if (!password || password.length < 8) {
      return response.validationError(res, 'Password must be at least 8 characters');
    }

    const passwordHash = await hashPassword(password);
    await db.exec(`
      UPDATE users
      SET password_hash = ?, force_password_change = 1, updated_at = datetime('now')
      WHERE id = ?
    `, [passwordHash, req.params.id]);

    // Invalidate all sessions for this user
    await db.exec('DELETE FROM sessions WHERE user_id = ?', [req.params.id]);

    response.success(res, { reset: true });
  } catch (err) {
    console.error('Error resetting password:', err);
    response.serverError(res);
  }
});

export default router;
