import db from '../db/connection.js';
import * as response from '../utils/response.js';

/**
 * Middleware to authenticate users via session cookie
 * Attaches user object to req.user if authenticated
 */
export function userAuth(req, res, next) {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return response.unauthorized(res, 'Session required');
  }

  const session = db.prepare(`
    SELECT
      s.id as session_id,
      s.expires_at,
      u.id as user_id,
      u.email,
      u.name,
      u.role,
      u.status
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sessionId);

  if (!session) {
    res.clearCookie('session');
    return response.unauthorized(res, 'Invalid session');
  }

  // Check if session is expired
  if (new Date(session.expires_at) < new Date()) {
    // Delete expired session
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
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
    role: session.role
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
export function optionalUserAuth(req, res, next) {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return next();
  }

  const session = db.prepare(`
    SELECT
      s.id as session_id,
      s.expires_at,
      u.id as user_id,
      u.email,
      u.name,
      u.role,
      u.status
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND u.status = 'active'
  `).get(sessionId);

  if (session && new Date(session.expires_at) >= new Date()) {
    req.user = {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role
    };
  }

  next();
}
