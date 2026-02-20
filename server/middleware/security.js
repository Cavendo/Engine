import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { generateCsrfToken } from '../utils/crypto.js';
import * as response from '../utils/response.js';

// ============================================
// Rate Limiting
// ============================================

/**
 * General API rate limiter
 * Default: 300 requests per minute per IP (configurable via RATE_LIMIT_API env var)
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_API || '300'),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests, please try again later'
    }
  }
});

/**
 * Strict rate limiter for authentication endpoints
 * 5 attempts per 15 minutes per IP
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed attempts
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many login attempts, please try again in 15 minutes'
    }
  }
});

/**
 * Rate limiter for API key generation
 * 10 requests per hour per IP
 */
export const keyGenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many key generation requests, please try again later'
    }
  }
});

/**
 * Rate limiter for webhook endpoints
 * 1000 requests per minute per IP (for high-volume webhook operations)
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many webhook requests'
    }
  }
});

// ============================================
// CSRF Protection
// ============================================

const CSRF_COOKIE_NAME = 'csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_TOKEN_LENGTH = 64;

/**
 * Generate and set CSRF token cookie
 * Call this after successful login
 */
export function setCsrfToken(res) {
  const token = generateCsrfToken();
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // Needs to be readable by JS to send in header
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
  return token;
}

/**
 * Clear CSRF token cookie
 * Call this on logout
 */
export function clearCsrfToken(res) {
  res.clearCookie(CSRF_COOKIE_NAME);
}

/**
 * CSRF protection middleware
 * Validates CSRF token for state-changing requests
 *
 * Exempt:
 * - GET, HEAD, OPTIONS requests
 * - Agent API requests (use API key auth)
 * - Requests without session cookie
 */
export function csrfProtection(req, res, next) {
  // Skip for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Skip for agent API requests
  if (req.headers['x-agent-key']) {
    return next();
  }

  // Skip if no session cookie (not logged in)
  if (!req.cookies?.session) {
    return next();
  }

  // Get tokens
  const cookieToken = req.cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  // Validate presence
  if (!cookieToken || !headerToken) {
    return response.forbidden(res, 'CSRF token missing');
  }

  // Validate match using timing-safe comparison
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(cookieToken, 'utf8'),
      Buffer.from(headerToken, 'utf8')
    );
    if (!valid) {
      return response.forbidden(res, 'CSRF token invalid');
    }
  } catch {
    return response.forbidden(res, 'CSRF token invalid');
  }

  next();
}

// ============================================
// Security Headers (additional to Helmet)
// ============================================

/**
 * Additional security headers middleware
 */
export function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Enable XSS filter
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  next();
}

// ============================================
// Request Sanitization
// ============================================

/**
 * Sanitize request body to prevent prototype pollution
 */
export function sanitizeRequest(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    const MAX_DEPTH = 20;
    const sanitize = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) return;
      delete obj.__proto__;
      delete obj.constructor;
      delete obj.prototype;
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object') {
          sanitize(obj[key], depth + 1);
        }
      }
    };
    sanitize(req.body);
  }
  next();
}
