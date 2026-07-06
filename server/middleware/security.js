import crypto from 'crypto';
import net from 'net';
import rateLimit from 'express-rate-limit';
import { generateCsrfToken } from '../utils/crypto.js';
import { extractApiKeyFromRequest } from '../utils/apiKeyHeaders.js';
import { getClientIp, normalizeIpAddress } from '../utils/clientIp.js';
import * as response from '../utils/response.js';

// ============================================
// Rate Limiting
// ============================================

/**
 * General pre-auth API rate limiter.
 * Default: 300 requests per minute per resolved client IP
 * (configurable via RATE_LIMIT_API env var)
 */
function parseRateLimitAllowlist(raw = process.env.RATE_LIMIT_API_ALLOWLIST || '') {
  const blockList = new net.BlockList();
  const entries = String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const cidrMatch = entry.match(/^(.+)\/(\d{1,3})$/);
    if (cidrMatch) {
      const address = normalizeIpAddress(cidrMatch[1]);
      const prefix = parseInt(cidrMatch[2], 10);
      const family = net.isIP(address);
      if (family === 4 && prefix >= 0 && prefix <= 32) {
        blockList.addSubnet(address, prefix, 'ipv4');
      } else if (family === 6 && prefix >= 0 && prefix <= 128) {
        blockList.addSubnet(address, prefix, 'ipv6');
      }
      continue;
    }

    const address = normalizeIpAddress(entry);
    const family = net.isIP(address);
    if (family === 4) {
      blockList.addAddress(address, 'ipv4');
    } else if (family === 6) {
      blockList.addAddress(address, 'ipv6');
    }
  }

  return blockList;
}

export function isApiRateLimitAllowlisted(req, rawAllowlist = process.env.RATE_LIMIT_API_ALLOWLIST || '') {
  const ip = getClientIp(req);
  if (!ip) return false;

  const family = net.isIP(ip);
  if (!family) return false;

  const blockList = parseRateLimitAllowlist(rawAllowlist);
  if (family === 4) return blockList.check(ip, 'ipv4');
  if (family === 6) return blockList.check(ip, 'ipv6');
  return false;
}

export function getApiRateLimitKey(req) {
  const clientIp = getClientIp(req);
  return `ip:${clientIp}`;
}

export function getAuthenticatedRateLimitKey(req) {
  if (req.agent?.isUserKey && req.agent.keyId) {
    return `user-key:${req.agent.keyId}`;
  }
  if (req.agent?.keyId) {
    return `agent-key:${req.agent.keyId}`;
  }
  if (req.agent?.id) {
    return `agent:${req.agent.id}`;
  }
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  return getApiRateLimitKey(req);
}

export function createApiLimiter(overrides = {}) {
  const { skip: customSkip, ...restOverrides } = overrides;
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: parseInt(process.env.RATE_LIMIT_API || '300'),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getApiRateLimitKey,
    skip: async (req, res) => {
      if (isApiRateLimitAllowlisted(req)) {
        return true;
      }
      if (typeof customSkip === 'function') {
        return await customSkip(req, res);
      }
      return false;
    },
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests, please try again later'
      }
    },
    ...restOverrides
  });
}

export const apiLimiter = createApiLimiter();

export function createAuthenticatedApiLimiter(overrides = {}) {
  const { skip: customSkip, ...restOverrides } = overrides;
  return rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_AUTHENTICATED || '3000', 10),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getAuthenticatedRateLimitKey,
    skip: async (req, res) => {
      if (!req.agent && !req.user) return true;
      if (typeof customSkip === 'function') {
        return await customSkip(req, res);
      }
      return false;
    },
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many authenticated requests, please try again later'
      }
    },
    ...restOverrides
  });
}

export const authenticatedApiLimiter = createAuthenticatedApiLimiter();

/**
 * Strict rate limiter for authentication endpoints
 * 5 attempts per 15 minutes per IP
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req) || String(req.ip || ''),
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
  keyGenerator: (req) => getClientIp(req) || String(req.ip || ''),
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
  keyGenerator: (req) => getClientIp(req) || String(req.ip || ''),
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
const PROOF_PROXY_PATH_PREFIX = String(process.env.PROOF_PROXY_PATH_PREFIX || '/proof').trim() || '/proof';
const CSRF_EXEMPT_POST_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/client-login',
  '/oauth/approve',
  '/oauth/deny',
]);

function normalizePath(pathValue) {
  const raw = String(pathValue || '').trim();
  if (!raw) return '';
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

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

  if (normalizePath(req.path).startsWith(PROOF_PROXY_PATH_PREFIX)) {
    return next();
  }

  // Skip login/session-bootstrap endpoints. These can be called while a stale
  // session cookie exists client-side, before a CSRF token is (re)issued.
  if (req.method === 'POST' && CSRF_EXEMPT_POST_PATHS.has(normalizePath(req.path))) {
    return next();
  }

  // Skip for agent API requests
  if (extractApiKeyFromRequest(req)) {
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
  if (normalizePath(req.path).startsWith(PROOF_PROXY_PATH_PREFIX)) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  } else {
    res.setHeader('X-Frame-Options', 'DENY');
  }

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
