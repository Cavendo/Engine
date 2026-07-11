import db from '../db/adapter.js';
import * as response from '../utils/response.js';
import { hashSessionToken } from '../utils/crypto.js';
import { authenticatedApiLimiter } from './security.js';

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/csrf',
  '/api/auth/change-password',
]);

async function resolveUserSession(req) {
  const sessionToken = String(req.cookies?.session || '');

  if (!sessionToken) {
    return { ok: false, reason: 'missing_session' };
  }
  const sessionTokenHash = hashSessionToken(sessionToken);

  const session = await db.one(`
    SELECT
      s.id as session_id,
      s.token_hash,
      s.expires_at,
      s.last_activity_at,
      s.revoked_at,
      u.id as user_id,
      u.email,
      u.name,
      u.role,
      u.status,
      u.force_password_change
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? OR (s.token_hash IS NULL AND s.id = ?)
  `, [sessionTokenHash, sessionToken]);

  if (!session) {
    return { ok: false, reason: 'invalid_session', clearCookie: true };
  }

  if (session.revoked_at || new Date(session.expires_at) < new Date()) {
    await db.exec(`
      DELETE FROM sessions
      WHERE token_hash = ? OR (token_hash IS NULL AND id = ?)
    `, [sessionTokenHash, sessionToken]);
    return { ok: false, reason: 'expired_session', clearCookie: true };
  }

  if (session.status !== 'active') {
    return { ok: false, reason: 'inactive_account' };
  }

  await db.exec(
    "UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?",
    [session.session_id]
  );

  const user = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role,
    forcePasswordChange: Boolean(session.force_password_change)
  };

  return { ok: true, user, sessionId: session.session_id };
}

/**
 * Non-writing probe for user session auth (for anyAuth composition).
 */
export async function userAuthProbe(req) {
  const result = await resolveUserSession(req);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  if (result.user.forcePasswordChange) {
    return { ok: false, reason: 'password_change_required' };
  }
  return {
    ok: true,
    user: result.user,
    auth: {
      type: 'user',
      actorType: 'user',
      actorId: `user:${result.user.id}`
    }
  };
}

/**
 * Middleware to authenticate users via session cookie
 * Attaches user object to req.user if authenticated
 */
export async function userAuth(req, res, next) {
  const result = await resolveUserSession(req);
  if (!result.ok) {
    if (result.clearCookie) {
      res.clearCookie('session');
    }
    if (result.reason === 'missing_session') {
      return response.unauthorized(res, 'Session required');
    }
    if (result.reason === 'invalid_session') {
      return response.unauthorized(res, 'Invalid session');
    }
    if (result.reason === 'expired_session') {
      return response.unauthorized(res, 'Session expired');
    }
    return response.forbidden(res, 'Account is inactive');
  }

  req.user = result.user;
  req.auth = {
    type: 'user',
    actorType: 'user',
    actorId: `user:${result.user.id}`
  };
  req.session = { id: result.sessionId };

  const requestPath = req.originalUrl?.split('?')[0] || req.path;
  if (result.user.forcePasswordChange && !PASSWORD_CHANGE_ALLOWED_PATHS.has(requestPath)) {
    return response.forbidden(res, 'Password change required before accessing this resource');
  }

  return authenticatedApiLimiter(req, res, next);
}

/**
 * Middleware to require specific roles
 * @param {...string} allowedRoles - Allowed roles
 */
export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return response.unauthorized(res, 'Authentication required');
    }

    if (!allowedRoles.includes(req.user.role)) {
      return response.forbidden(res, 'Insufficient permissions');
    }

    next();
  };
}

/**
 * Middleware for routes that represent human privileges but may be called
 * through either a browser session or a user API key. Regular agent keys are
 * intentionally not mapped to roles here.
 * @param {...string} allowedRoles - Allowed user roles
 */
export function requireUserOrUserKeyRoles(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user?.role || (req.agent?.isUserKey ? req.agent.userRole : null);

    if (!role) {
      if (req.agent && !req.agent.isUserKey) {
        return response.forbidden(res, 'User session or user API key required');
      }
      return response.unauthorized(res, 'Authentication required');
    }

    if (!allowedRoles.includes(role)) {
      return response.forbidden(res, 'Insufficient permissions');
    }

    next();
  };
}

/**
 * Optional user auth - doesn't fail if no session
 */
export async function optionalUserAuth(req, res, next) {
  if (!req.cookies?.session) {
    return next();
  }
  const result = await resolveUserSession(req);
  if (result.ok) {
    req.user = result.user;
    req.session = { id: result.sessionId };
  } else if (result.clearCookie) {
    res.clearCookie('session');
  }

  next();
}
