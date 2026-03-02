import crypto from 'crypto';
import * as response from '../utils/response.js';

const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function timingSafeEqualString(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function normalizeInternalActor(req) {
  const rawName = (req.headers['x-internal-service-name'] || '').toString().trim().toLowerCase();
  const serviceName = rawName || 'internal';
  if (!SERVICE_NAME_PATTERN.test(serviceName)) {
    return { ok: false, error: 'Invalid internal service name' };
  }
  return {
    ok: true,
    auth: {
      type: 'internal',
      actorType: 'system',
      actorId: `system:${serviceName}`,
      serviceName
    }
  };
}

export async function internalServiceAuthProbe(req) {
  const configured = process.env.INTERNAL_SERVICE_TOKEN;
  if (!configured) {
    return { ok: false, reason: 'internal_token_not_configured' };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing_bearer' };
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!timingSafeEqualString(token, configured)) {
    return { ok: false, reason: 'invalid_token' };
  }

  const actor = normalizeInternalActor(req);
  if (!actor.ok) {
    return { ok: false, reason: 'invalid_service_name' };
  }

  return { ok: true, auth: actor.auth };
}

export async function internalServiceAuth(req, res, next) {
  const result = await internalServiceAuthProbe(req);
  if (!result.ok) {
    return response.unauthorized(res, 'Invalid internal service token');
  }
  req.auth = result.auth;
  next();
}
