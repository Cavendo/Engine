import db from '../db/adapter.js';
import * as response from '../utils/response.js';

/**
 * Middleware to authenticate users via session cookie
 * Attaches user object to req.user if authenticated
 */
export async function userAuth(req, res, next) {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return response.unauthorized(res, 'Session required');
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
    res.clearCookie('session');
    return response.unauthorized(res, 'Invalid session');
  }

  // Check if session is expired
  if (new Date(session.expires_at) < new Date()) {
    // Delete expired session
    await db.exec('DELETE FROM sessions WHERE id = ?', [sessionId]);
    res.clearCookie('session');
    return response.unauthorized(res, 'Session expired');
  }

  // Check if user is active
  if (session.status !== 'active') {
    return response.forbidden(res, 'Account is inactive');
  }

  // Attach user to request
  req.user = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role,
    forcePasswordChange: Boolean(session.force_password_change)
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
