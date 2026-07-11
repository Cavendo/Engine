import { timingSafeEqual } from 'crypto';
import db from '../db/adapter.js';
import { hashApiKey } from '../utils/crypto.js';
import { getClientIp } from '../utils/clientIp.js';
import * as response from '../utils/response.js';
import { extractApiKeyFromRequest } from '../utils/apiKeyHeaders.js';
import { userAuth } from './userAuth.js';
import { authenticatedApiLimiter } from './security.js';

function safeJsonParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function buildUserKeyAgent(userKey, ownedAgentIds) {
  const ROLE_SCOPES = {
    admin: ['*'],
    operator: ['tasks:read', 'tasks:write', 'deliverables:read', 'deliverables:write', 'projects:read', 'agents:read', 'knowledge:read', 'knowledge:write', 'workflows:read', 'workflows:write'],
    reviewer: ['tasks:read', 'tasks:write', 'deliverables:read', 'deliverables:write', 'deliverables:review', 'projects:read', 'agents:read', 'knowledge:read', 'knowledge:write'],
    viewer: ['tasks:read', 'deliverables:read', 'projects:read', 'agents:read', 'knowledge:read']
  };
  const ROLE_CAPABILITIES = {
    admin: ['*'],
    operator: ['operate', 'review', 'write', 'read'],
    reviewer: ['review', 'write', 'read'],
    viewer: ['read']
  };

  const roleScopes = ROLE_SCOPES[userKey.role] || ROLE_SCOPES.viewer;
  const roleCapabilities = ROLE_CAPABILITIES[userKey.role] || ROLE_CAPABILITIES.viewer;

  return {
    id: null,
    name: userKey.user_name || userKey.email,
    type: 'user',
    capabilities: roleCapabilities,
    status: 'active',
    maxConcurrentTasks: 999,
    keyId: userKey.key_id,
    scopes: roleScopes,
    isUserKey: true,
    userId: userKey.user_id,
    userName: userKey.user_name,
    userEmail: userKey.email,
    userRole: userKey.role,
    keyName: userKey.key_name || null,
    ownedAgentIds
  };
}

function buildAgentKeyActor(agentKey) {
  const scopes = safeJsonParse(agentKey.scopes, []);
  const capabilities = safeJsonParse(agentKey.capabilities, []);

  return {
    id: agentKey.agent_id,
    name: agentKey.name,
    type: agentKey.type,
    capabilities,
    status: agentKey.status,
    maxConcurrentTasks: agentKey.max_concurrent_tasks,
    keyId: agentKey.key_id,
    scopes,
    ownerUserId: agentKey.owner_user_id,
    ownerName: agentKey.owner_name,
    ownerEmail: agentKey.owner_email,
    projectAccess: safeJsonParse(agentKey.project_access, ['*'])
  };
}

async function loadUserKeyAgent(keyHash) {
  const userKey = await db.one(`
    SELECT
      uk.id as key_id,
      uk.key_hash,
      uk.name as key_name,
      uk.user_id,
      u.name as user_name,
      u.email,
      u.role,
      u.status,
      u.force_password_change
    FROM user_keys uk
    JOIN users u ON u.id = uk.user_id
    WHERE uk.key_hash = ?
  `, [keyHash]);

  if (!userKey) {
    const err = new Error('Invalid API key');
    err.status = 401;
    throw err;
  }

  const keyHashBuffer = Buffer.from(keyHash, 'hex');
  const storedHashBuffer = Buffer.from(userKey.key_hash, 'hex');
  if (keyHashBuffer.length !== storedHashBuffer.length ||
      !timingSafeEqual(keyHashBuffer, storedHashBuffer)) {
    const err = new Error('Invalid API key');
    err.status = 401;
    throw err;
  }

  if (userKey.status !== 'active') {
    const err = new Error(`User account is ${userKey.status}`);
    err.status = 403;
    throw err;
  }

  if (userKey.force_password_change) {
    const err = new Error('Password change required before using API keys');
    err.status = 403;
    throw err;
  }

  await db.exec(`
    UPDATE user_keys SET last_used_at = datetime('now') WHERE id = ?
  `, [userKey.key_id]);

  const ownedAgents = await db.many(
    'SELECT id FROM agents WHERE owner_user_id = ? AND status = \'active\'',
    [userKey.user_id]
  );
  const ownedAgentIds = ownedAgents.map((a) => a.id);
  return buildUserKeyAgent(userKey, ownedAgentIds);
}

async function loadAgentKeyActor(keyHash) {
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
      a.project_access,
      a.owner_user_id,
      u.name as owner_name,
      u.email as owner_email
    FROM agent_keys ak
    JOIN agents a ON a.id = ak.agent_id
    LEFT JOIN users u ON u.id = a.owner_user_id
    WHERE ak.key_hash = ?
  `, [keyHash]);

  if (!agentKey) {
    const err = new Error('Invalid API key');
    err.status = 401;
    throw err;
  }

  const keyHashBuffer = Buffer.from(keyHash, 'hex');
  const storedHashBuffer = Buffer.from(agentKey.key_hash, 'hex');
  if (keyHashBuffer.length !== storedHashBuffer.length ||
      !timingSafeEqual(keyHashBuffer, storedHashBuffer)) {
    const err = new Error('Invalid API key');
    err.status = 401;
    throw err;
  }

  if (agentKey.revoked_at) {
    const err = new Error('API key has been revoked');
    err.status = 401;
    throw err;
  }

  if (agentKey.expires_at && new Date(agentKey.expires_at) < new Date()) {
    const err = new Error('API key has expired');
    err.status = 401;
    throw err;
  }

  if (agentKey.status !== 'active') {
    const err = new Error(`Agent is ${agentKey.status}`);
    err.status = 403;
    throw err;
  }

  await db.exec(`
    UPDATE agent_keys SET last_used_at = datetime('now') WHERE id = ?
  `, [agentKey.key_id]);

  return buildAgentKeyActor(agentKey);
}

export async function resolveApiKeyActor(apiKey) {
  const normalizedApiKey = String(apiKey || '').trim();
  if (!normalizedApiKey) {
    const err = new Error('Missing X-Agent-Key header');
    err.status = 401;
    throw err;
  }

  const keyHash = hashApiKey(normalizedApiKey);
  if (normalizedApiKey.startsWith('cav_uk_')) {
    return loadUserKeyAgent(keyHash);
  }
  return loadAgentKeyActor(keyHash);
}

/**
 * Middleware to authenticate agents via X-Agent-Key header
 * Supports both agent keys (cav_ak_...) and user keys (cav_uk_...)
 * Attaches agent object to req.agent if authenticated
 */
export async function agentAuth(req, res, next) {
  const apiKey = extractApiKeyFromRequest(req);

  if (!apiKey) {
    return response.unauthorized(res, 'Missing X-Agent-Key header');
  }

  try {
    req.agent = await resolveApiKeyActor(apiKey);
    return authenticatedApiLimiter(req, res, next);
  } catch (err) {
    if (err?.status === 401) {
      return response.unauthorized(res, err.message || 'Invalid API key');
    }
    if (err?.status === 403) {
      return response.forbidden(res, err.message || 'Access denied');
    }
    console.error('Agent auth error:', err);
    return response.serverError(res, 'Authentication failed');
  }
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
            getClientIp(req)
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
  const agentKey = extractApiKeyFromRequest(req);
  if (agentKey) {
    return agentAuth(req, res, next);
  }
  return userAuth(req, res, next);
}
