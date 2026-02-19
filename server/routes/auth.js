import { Router } from 'express';
import db from '../db/connection.js';
import { hashPassword, verifyPassword, generateSessionToken } from '../utils/crypto.js';
import * as response from '../utils/response.js';
import { userAuth } from '../middleware/userAuth.js';
import { authLimiter, setCsrfToken, clearCsrfToken } from '../middleware/security.js';
import { validateBody, loginSchema, changePasswordSchema } from '../utils/validation.js';

const router = Router();

const SESSION_DURATION_HOURS = 24 * 7; // 7 days

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', authLimiter, validateBody(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = db.prepare(`
      SELECT id, email, password_hash, name, role, status
      FROM users
      WHERE email = ?
    `).get(email.toLowerCase());

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

    // Session regeneration: Delete any existing sessions for this user
    // This prevents session fixation and ensures fresh session on login
    db.prepare(`
      DELETE FROM sessions WHERE user_id = ?
    `).run(user.id);

    // Create new session with cryptographically random ID
    const sessionId = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(sessionId, user.id, expiresAt);

    // Update last login
    db.prepare(`
      UPDATE users SET last_login_at = datetime('now') WHERE id = ?
    `).run(user.id);

    // Set session cookie
    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_DURATION_HOURS * 60 * 60 * 1000
    });

    // Set CSRF token
    const csrfToken = setCsrfToken(res);

    response.success(res, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
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
router.post('/logout', (req, res) => {
  const sessionId = req.cookies?.session;

  if (sessionId) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    res.clearCookie('session');
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

    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);

    // Verify current password (async)
    const passwordValid = await verifyPassword(currentPassword, user.password_hash);
    if (!passwordValid) {
      return response.unauthorized(res, 'Current password is incorrect');
    }

    // Hash new password (async)
    const newHash = await hashPassword(newPassword);

    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(newHash, req.user.id);

    // Invalidate all other sessions
    db.prepare(`
      DELETE FROM sessions WHERE user_id = ? AND id != ?
    `).run(req.user.id, req.cookies?.session);

    response.success(res, { passwordChanged: true });
  } catch (err) {
    console.error('Error changing password:', err);
    response.serverError(res);
  }
});

export default router;
