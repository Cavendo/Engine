import db from '../db/adapter.js';
import * as response from '../utils/response.js';

async function resolveUserSession(req) {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return { ok: false, reason: 'missing_session' };
  }

  const session = await db.one(`
    SELECT
      s.id as session_id,
      s.expires_at,
      u.id as user_id,
      u.email,
      u.name,
      u.role,
      u.status,
      u.force_password_change
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `, [sessionId]);

  if (!session) {
    return { ok: false, reason: 'invalid_session', clearCookie: true };
  }

  if (new Date(session.expires_at) < new Date()) {
    await db.exec('DELETE FROM sessions WHERE id = ?', [sessionId]);
    return { ok: false, reason: 'expired_session', clearCookie: true };
  }

  if (session.status !== 'active') {
    return { ok: false, reason: 'inactive_account' };
  }

  const user = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role,
    forcePasswordChange: Boolean(session.force_password_change)
  };

  return { ok: true, user };
}

/**
 * Non-writing probe for user session auth (for anyAuth composition).
 */
export async function userAuthProbe(req) {
  const result = await resolveUserSession(req);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
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

  next();
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
 * Optional user auth - doesn't fail if no session
 */
export async function optionalUserAuth(req, res, next) {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return next();
  }

  const session = await db.one(`
    SELECT
      s.id as session_id,
      s.expires_at,
      u.id as user_id,
      u.email,
      u.name,
      u.role,
      u.status,
      u.force_password_change
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND u.status = 'active'
  `, [sessionId]);

  if (session && new Date(session.expires_at) >= new Date()) {
    req.user = {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role,
      forcePasswordChange: Boolean(session.force_password_change)
    };
  }

  next();
}
