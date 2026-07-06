import { Router } from 'express';
import db from '../db/adapter.js';
import { hashPassword, verifyPassword, generateSessionToken, hashSessionToken } from '../utils/crypto.js';
import { getClientIp as resolveClientIp } from '../utils/clientIp.js';
import * as response from '../utils/response.js';
import { userAuth } from '../middleware/userAuth.js';
import { authLimiter, setCsrfToken, clearCsrfToken } from '../middleware/security.js';
import { validateBody, loginSchema, changePasswordSchema } from '../utils/validation.js';

const router = Router();

const SESSION_DURATION_HOURS = parseInt(process.env.SESSION_DURATION_HOURS || '', 10) || (24 * 7); // 7 days
const MAX_SESSIONS_PER_USER = Math.max(1, parseInt(process.env.MAX_SESSIONS_PER_USER || '', 10) || 10);

function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_DURATION_HOURS * 60 * 60 * 1000,
    path: '/'
  };
}

function getSessionCookieClearOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  };
}

function getClientIp(req) {
  return resolveClientIp(req).slice(0, 255);
}

function getUserAgent(req) {
  return String(req.headers['user-agent'] || '').slice(0, 512) || null;
}

async function createUserSession(userId, req) {
  const sessionToken = generateSessionToken();
  const sessionHash = hashSessionToken(sessionToken);
  const sessionRecordId = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();

  await db.exec(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, last_activity_at, user_agent, ip_address)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
  `, [sessionRecordId, userId, sessionHash, expiresAt, getUserAgent(req), getClientIp(req)]);

  // Keep recent sessions per user and prune old ones.
  const existingSessions = await db.many(`
    SELECT id
    FROM sessions
    WHERE user_id = ?
    ORDER BY created_at DESC
  `, [userId]);

  const staleSessionIds = existingSessions.slice(MAX_SESSIONS_PER_USER).map(row => row.id);
  for (const staleId of staleSessionIds) {
    await db.exec('DELETE FROM sessions WHERE id = ?', [staleId]);
  }

  return { sessionToken, expiresAt };
}

async function deleteSessionByCookieToken(cookieToken) {
  const token = String(cookieToken || '');
  if (!token) return;
  const tokenHash = hashSessionToken(token);
  await db.exec(`
    DELETE FROM sessions
    WHERE token_hash = ? OR (token_hash IS NULL AND id = ?)
  `, [tokenHash, token]);
}

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', authLimiter, validateBody(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await db.one(`
      SELECT id, email, password_hash, name, role, status, force_password_change
      FROM users
      WHERE email = ?
    `, [email.toLowerCase()]);

    if (!user) {
      return response.unauthorized(res, 'Invalid email or password');
    }

    if (user.status !== 'active') {
      return response.forbidden(res, 'Account is inactive');
    }

    // Verify password using bcrypt (async)
    const passwordValid = await verifyPassword(password, user.password_hash);
    if (!passwordValid) {
      return response.unauthorized(res, 'Invalid email or password');
    }

    const { sessionToken, expiresAt } = await createUserSession(user.id, req);

    // Update last login
    await db.exec(`
      UPDATE users SET last_login_at = datetime('now') WHERE id = ?
    `, [user.id]);

    // Set session cookie
    res.cookie('session', sessionToken, getSessionCookieOptions());

    // Set CSRF token
    const csrfToken = setCsrfToken(res);

    response.success(res, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        forcePasswordChange: Boolean(user.force_password_change)
      },
      expiresAt,
      csrfToken // Return token so client can store it
    });
  } catch (err) {
    console.error('Error during login:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/auth/logout
 * Logout current session
 */
router.post('/logout', async (req, res) => {
  const cookieToken = req.cookies?.session;

  if (cookieToken) {
    await deleteSessionByCookieToken(cookieToken);
    res.clearCookie('session', getSessionCookieClearOptions());
  }

  // Clear CSRF token
  clearCsrfToken(res);

  response.success(res, { loggedOut: true });
});

/**
 * GET /api/auth/me
 * Get current user
 */
router.get('/me', userAuth, (req, res) => {
  response.success(res, {
    user: req.user
  });
});

/**
 * GET /api/auth/csrf
 * Get a new CSRF token (for SPA refresh)
 */
router.get('/csrf', userAuth, (req, res) => {
  const csrfToken = setCsrfToken(res);
  response.success(res, { csrfToken });
});

/**
 * POST /api/auth/change-password
 * Change password
 */
router.post('/change-password', userAuth, validateBody(changePasswordSchema), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await db.one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);

    // Verify current password (async)
    const passwordValid = await verifyPassword(currentPassword, user.password_hash);
    if (!passwordValid) {
      return response.unauthorized(res, 'Current password is incorrect');
    }

    // Hash new password (async)
    const newHash = await hashPassword(newPassword);

    await db.exec(`
      UPDATE users
      SET password_hash = ?, force_password_change = 0, updated_at = datetime('now')
      WHERE id = ?
    `, [newHash, req.user.id]);

    // Rotate current session and invalidate all existing sessions for this user.
    await db.exec('DELETE FROM sessions WHERE user_id = ?', [req.user.id]);
    const { sessionToken, expiresAt } = await createUserSession(req.user.id, req);
    res.cookie('session', sessionToken, getSessionCookieOptions());
    const csrfToken = setCsrfToken(res);

    // Return updated user so frontend can refresh auth state
    const updated = await db.one('SELECT id, email, name, role, force_password_change FROM users WHERE id = ?', [req.user.id]);
    response.success(res, {
      passwordChanged: true,
      expiresAt,
      csrfToken,
      user: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        forcePasswordChange: Boolean(updated.force_password_change)
      }
    });
  } catch (err) {
    console.error('Error changing password:', err);
    response.serverError(res);
  }
});

export default router;
