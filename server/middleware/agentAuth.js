import { timingSafeEqual } from 'crypto';
import db from '../db/adapter.js';
import { hashApiKey } from '../utils/crypto.js';
import * as response from '../utils/response.js';
import { userAuth } from './userAuth.js';

function safeJsonParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

/**
 * Middleware to authenticate agents via X-Agent-Key header
 * Supports both agent keys (cav_ak_...) and user keys (cav_uk_...)
 * Attaches agent object to req.agent if authenticated
 */
export async function agentAuth(req, res, next) {
  const apiKey = req.headers['x-agent-key'];

  if (!apiKey) {
    return response.unauthorized(res, 'Missing X-Agent-Key header');
  }

  // Hash the provided key
  const keyHash = hashApiKey(apiKey);

  // Check if this is a user key (cav_uk_...)
  if (apiKey.startsWith('cav_uk_')) {
    return authenticateUserKey(keyHash, req, res, next);
  }

  // Otherwise treat as agent key (cav_ak_...)
  return authenticateAgentKey(keyHash, req, res, next);
}

/**
 * Authenticate using a user key (cav_uk_...)
 * The user becomes the "agent" for MCP purposes
 */
async function authenticateUserKey(keyHash, req, res, next) {
  const userKey = await db.one(`
    SELECT
      uk.id as key_id,
      uk.key_hash,
      uk.user_id,
      u.name as user_name,
      u.email,
      u.role,
      u.status
    FROM user_keys uk
    JOIN users u ON u.id = uk.user_id
    WHERE uk.key_hash = ?
  `, [keyHash]);

  if (!userKey) {
    return response.unauthorized(res, 'Invalid API key');
  }

  // Timing-safe comparison to prevent timing attacks
  const keyHashBuffer = Buffer.from(keyHash, 'hex');
  const storedHashBuffer = Buffer.from(userKey.key_hash, 'hex');
  if (keyHashBuffer.length !== storedHashBuffer.length ||
      !timingSafeEqual(keyHashBuffer, storedHashBuffer)) {
    return response.unauthorized(res, 'Invalid API key');
  }

  if (userKey.status !== 'active') {
    return response.forbidden(res, `User account is ${userKey.status}`);
  }

  // Update last used timestamp
  await db.exec(`
    UPDATE user_keys SET last_used_at = datetime('now') WHERE id = ?
  `, [userKey.key_id]);

  // Find agents owned by this user (for scoping "my tasks" queries)
  const ownedAgents = await db.many(
    'SELECT id FROM agents WHERE owner_user_id = ? AND status = \'active\'',
    [userKey.user_id]
  );
  const ownedAgentIds = ownedAgents.map(a => a.id);

  // VULN-005: Scope user keys to actual user role instead of granting wildcard
  const ROLE_SCOPES = {
    admin: ['*'],
    reviewer: ['tasks:read', 'tasks:write', 'deliverables:read', 'deliverables:write', 'deliverables:review', 'projects:read', 'agents:read', 'knowledge:read', 'knowledge:write'],
    viewer: ['tasks:read', 'deliverables:read', 'projects:read', 'agents:read', 'knowledge:read']
  };
  const ROLE_CAPABILITIES = {
    admin: ['*'],
    reviewer: ['review', 'write', 'read'],
    viewer: ['read']
  };

  const roleScopes = ROLE_SCOPES[userKey.role] || ROLE_SCOPES.viewer;
  const roleCapabilities = ROLE_CAPABILITIES[userKey.role] || ROLE_CAPABILITIES.viewer;

  // Create a virtual agent representing the user
  req.agent = {
    id: null, // No agent ID for user keys
    name: userKey.user_name || userKey.email,
    type: 'user',
    capabilities: roleCapabilities,
    status: 'active',
    maxConcurrentTasks: 999,
    keyId: userKey.key_id,
    scopes: roleScopes,
    // User-specific fields
    isUserKey: true,
    userId: userKey.user_id,
    userName: userKey.user_name,
    userEmail: userKey.email,
    userRole: userKey.role,
    ownedAgentIds // Array of agent IDs owned by this user
  };

  next();
}

/**
 * Authenticate using an agent key (cav_ak_...)
 * Also resolves owner user if agent is linked to a user
 */
async function authenticateAgentKey(keyHash, req, res, next) {
  const agentKey = await db.one(`
    SELECT
      ak.id as key_id,
      ak.key_hash,
      ak.agent_id,
      ak.scopes,
      ak.revoked_at,
      ak.expires_at,
      a.id,
      a.name,
      a.type,
      a.capabilities,
      a.status,
      a.max_concurrent_tasks,
      a.owner_user_id,
      u.name as owner_name,
      u.email as owner_email
    FROM agent_keys ak
    JOIN agents a ON a.id = ak.agent_id
    LEFT JOIN users u ON u.id = a.owner_user_id
    WHERE ak.key_hash = ?
  `, [keyHash]);

  if (!agentKey) {
    return response.unauthorized(res, 'Invalid API key');
  }

  // Timing-safe comparison to prevent timing attacks
  const keyHashBuffer = Buffer.from(keyHash, 'hex');
  const storedHashBuffer = Buffer.from(agentKey.key_hash, 'hex');
  if (keyHashBuffer.length !== storedHashBuffer.length ||
      !timingSafeEqual(keyHashBuffer, storedHashBuffer)) {
    return response.unauthorized(res, 'Invalid API key');
  }

  // Check if key is revoked
  if (agentKey.revoked_at) {
    return response.unauthorized(res, 'API key has been revoked');
  }

  // Check if key is expired
  if (agentKey.expires_at && new Date(agentKey.expires_at) < new Date()) {
    return response.unauthorized(res, 'API key has expired');
  }

  // Check if agent is active
  if (agentKey.status !== 'active') {
    return response.forbidden(res, `Agent is ${agentKey.status}`);
  }

  // Update last used timestamp
  await db.exec(`
    UPDATE agent_keys SET last_used_at = datetime('now') WHERE id = ?
  `, [agentKey.key_id]);

  // Parse JSON fields
  const scopes = safeJsonParse(agentKey.scopes, []);
  const capabilities = safeJsonParse(agentKey.capabilities, []);

  // Attach agent to request
  req.agent = {
    id: agentKey.agent_id,
    name: agentKey.name,
    type: agentKey.type,
    capabilities,
    status: agentKey.status,
    maxConcurrentTasks: agentKey.max_concurrent_tasks,
    keyId: agentKey.key_id,
    scopes,
    // Owner info (for "my tasks" queries)
    ownerUserId: agentKey.owner_user_id,
    ownerName: agentKey.owner_name,
    ownerEmail: agentKey.owner_email
  };

  next();
}

/**
 * Middleware to require specific scopes
 * @param {...string} requiredScopes - Required scopes
 */
export function requireScopes(...requiredScopes) {
  return (req, res, next) => {
    if (!req.agent) {
      return response.unauthorized(res, 'Agent authentication required');
    }

    const hasAllScopes = requiredScopes.every(scope =>
      req.agent.scopes.includes(scope) || req.agent.scopes.includes('*')
    );

    if (!hasAllScopes) {
      return response.forbidden(res, `Missing required scopes: ${requiredScopes.join(', ')}`);
    }

    next();
  };
}

/**
 * Middleware to log agent activity
 */
export function logAgentActivity(action, getResourceInfo) {
  return (req, res, next) => {
    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json to log after response
    res.json = (data) => {
      // Log activity asynchronously
      setImmediate(() => {
        // Skip activity logging for user keys - they have req.agent.id = null
        // and agent_activity.agent_id is NOT NULL in the schema.
        // User activity is already tracked via user_keys.last_used_at.
        if (req.agent && req.agent.id && res.statusCode < 400) {
          const resourceInfo = getResourceInfo ? getResourceInfo(req, data) : {};
          db.exec(`
            INSERT INTO agent_activity (agent_id, action, resource_type, resource_id, details, ip_address)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            req.agent.id,
            action,
            resourceInfo.type || null,
            resourceInfo.id || null,
            JSON.stringify(resourceInfo.details || {}),
            req.ip
          ]).catch(err => {
            console.error('Failed to log agent activity:', err);
          });
        }
      });

      return originalJson(data);
    };

    next();
  };
}

/**
 * Middleware that accepts either agent auth (X-Agent-Key) or user auth (session cookie)
 * Useful for endpoints that should be accessible by both agents and users
 */
export function dualAuth(req, res, next) {
  const agentKey = req.headers['x-agent-key'];
  if (agentKey) {
    return agentAuth(req, res, next);
  }
  return userAuth(req, res, next);
}
