import { Router } from 'express';
import db from '../db/adapter.js';
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

    // Session regeneration: Delete any existing sessions for this user
    // This prevents session fixation and ensures fresh session on login
    await db.exec(`
      DELETE FROM sessions WHERE user_id = ?
    `, [user.id]);

    // Create new session with cryptographically random ID
    const sessionId = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString();

    await db.exec(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, ?)
    `, [sessionId, user.id, expiresAt]);

    // Update last login
    await db.exec(`
      UPDATE users SET last_login_at = datetime('now') WHERE id = ?
    `, [user.id]);

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
  const sessionId = req.cookies?.session;

  if (sessionId) {
    await db.exec('DELETE FROM sessions WHERE id = ?', [sessionId]);
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

    // Invalidate all other sessions
    await db.exec(`
      DELETE FROM sessions WHERE user_id = ? AND id != ?
    `, [req.user.id, req.cookies?.session]);

    // Return updated user so frontend can refresh auth state
    const updated = await db.one('SELECT id, email, name, role, force_password_change FROM users WHERE id = ?', [req.user.id]);
    response.success(res, {
      passwordChanged: true,
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
