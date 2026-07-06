import { describe, expect, test } from '@jest/globals';

process.env.NODE_ENV = 'test';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const {
  createApiLimiter,
  createAuthenticatedApiLimiter,
  getAuthenticatedRateLimitKey,
  getApiRateLimitKey,
  isApiRateLimitAllowlisted,
} = await import('../middleware/security.js');

function createTestApp(limit = 1) {
  const app = express();
  app.use(cookieParser());
  app.use('/api', createApiLimiter({
    windowMs: 60 * 1000,
    max: limit,
  }));
  app.get('/api/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('API rate limiting', () => {
  test('keys pre-auth API requests by client IP even with an API key', () => {
    const req = {
      ip: '203.0.113.10',
      headers: {
        authorization: 'Bearer cav_uk_example_key'
      }
    };

    expect(getApiRateLimitKey(req)).toBe('ip:203.0.113.10');
  });

  test('falls back to IP for anonymous requests', () => {
    const req = {
      ip: '203.0.113.10',
      headers: {}
    };

    expect(getApiRateLimitKey(req)).toBe('ip:203.0.113.10');
  });

  test('keys anonymous requests by Cloudflare client IP when proxy trust is enabled', () => {
    const req = {
      ip: '198.51.100.20',
      headers: {
        'cf-connecting-ip': '203.0.113.10'
      },
      app: {
        get: (key) => (key === 'trust proxy' ? 1 : undefined)
      }
    };

    expect(getApiRateLimitKey(req)).toBe('ip:203.0.113.10');
  });

  test('detects exact IP allowlist matches', () => {
    const req = {
      ip: '203.0.113.10',
      headers: {}
    };

    expect(isApiRateLimitAllowlisted(req, '203.0.113.10')).toBe(true);
    expect(isApiRateLimitAllowlisted(req, '203.0.113.11')).toBe(false);
  });

  test('detects CIDR allowlist matches', () => {
    const req = {
      ip: '198.51.100.8',
      headers: {}
    };

    expect(isApiRateLimitAllowlisted(req, '198.51.100.0/24')).toBe(true);
    expect(isApiRateLimitAllowlisted(req, '198.51.101.0/24')).toBe(false);
  });

  test('normalizes IPv4-mapped IPv6 addresses for allowlist checks', () => {
    const req = {
      ip: '::ffff:203.0.113.10',
      headers: {}
    };

    expect(isApiRateLimitAllowlisted(req, '203.0.113.10')).toBe(true);
  });

  test('uses Cloudflare client IP header for allowlist checks when proxy trust is enabled', () => {
    const req = {
      ip: '198.51.100.20',
      headers: {
        'cf-connecting-ip': '203.0.113.10'
      },
      app: {
        get: (key) => (key === 'trust proxy' ? 1 : undefined)
      }
    };

    expect(isApiRateLimitAllowlisted(req, '203.0.113.10')).toBe(true);
  });

  test('does not trust Cloudflare client IP header when proxy trust is disabled', () => {
    const req = {
      ip: '198.51.100.20',
      headers: {
        'cf-connecting-ip': '203.0.113.10'
      },
      app: {
        get: () => false
      }
    };

    expect(isApiRateLimitAllowlisted(req, '203.0.113.10')).toBe(false);
  });

  test('keys pre-auth browser requests by client IP even with a session cookie', () => {
    const req = {
      ip: '203.0.113.10',
      headers: {},
      cookies: {
        session: 'browser-session-token'
      }
    };

    expect(getApiRateLimitKey(req)).toBe('ip:203.0.113.10');
  });

  test('keys post-auth API requests by verified identity', () => {
    expect(getAuthenticatedRateLimitKey({
      ip: '203.0.113.10',
      agent: { id: 7, keyId: 101 }
    })).toBe('agent-key:101');

    expect(getAuthenticatedRateLimitKey({
      ip: '203.0.113.10',
      agent: { isUserKey: true, userId: 3, keyId: 202 }
    })).toBe('user-key:202');

    expect(getAuthenticatedRateLimitKey({
      ip: '203.0.113.10',
      user: { id: 4 }
    })).toBe('user:4');
  });

  test('distinct forged API keys from one IP share the same limit bucket', async () => {
    const app = createTestApp(1);
    const { default: supertest } = await import('supertest');

    const first = await supertest(app)
      .get('/api/test')
      .set('Authorization', 'Bearer cav_uk_first');

    const second = await supertest(app)
      .get('/api/test')
      .set('Authorization', 'Bearer cav_uk_second');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  test('repeated requests with the same API key are rate limited together', async () => {
    const app = createTestApp(1);
    const { default: supertest } = await import('supertest');

    const first = await supertest(app)
      .get('/api/test')
      .set('X-API-Key', 'cav_uk_same_key');

    const second = await supertest(app)
      .get('/api/test')
      .set('X-API-Key', 'cav_uk_same_key');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  test('distinct forged browser sessions from one IP share the same limit bucket', async () => {
    const app = createTestApp(1);
    const { default: supertest } = await import('supertest');

    const first = await supertest(app)
      .get('/api/test')
      .set('Cookie', 'session=session_one');

    const second = await supertest(app)
      .get('/api/test')
      .set('Cookie', 'session=session_two');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error?.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  test('repeated requests with the same browser session are rate limited together', async () => {
    const app = createTestApp(1);
    const { default: supertest } = await import('supertest');

    const first = await supertest(app)
      .get('/api/test')
      .set('Cookie', 'session=session_repeat');

    const second = await supertest(app)
      .get('/api/test')
      .set('Cookie', 'session=session_repeat');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  test('anonymous requests still share the IP-based limit bucket', async () => {
    const app = createTestApp(1);
    const { default: supertest } = await import('supertest');

    const first = await supertest(app).get('/api/test');
    const second = await supertest(app).get('/api/test');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  test('post-auth limiter separates verified identities behind one IP', async () => {
    const app = express();
    app.use('/api', (req, _res, next) => {
      const actor = req.headers['x-test-actor'];
      req.agent = { id: actor === 'two' ? 2 : 1, keyId: actor === 'two' ? 22 : 11 };
      next();
    });
    app.use('/api', createAuthenticatedApiLimiter({
      windowMs: 60 * 1000,
      max: 1,
    }));
    app.get('/api/test', (_req, res) => {
      res.json({ ok: true });
    });

    const { default: supertest } = await import('supertest');
    const first = await supertest(app).get('/api/test').set('X-Test-Actor', 'one');
    const second = await supertest(app).get('/api/test').set('X-Test-Actor', 'two');
    const third = await supertest(app).get('/api/test').set('X-Test-Actor', 'one');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  test('allowlisted IPs bypass the API rate limiter', async () => {
    const app = express();
    app.use(cookieParser());
    app.set('trust proxy', 1);
    app.use('/api', createApiLimiter({
      windowMs: 60 * 1000,
      max: 1,
    }));
    app.get('/api/test', (_req, res) => {
      res.json({ ok: true });
    });

    process.env.RATE_LIMIT_API_ALLOWLIST = '203.0.113.10';

    const { default: supertest } = await import('supertest');
    const first = await supertest(app)
      .get('/api/test')
      .set('X-Forwarded-For', '203.0.113.10');

    const second = await supertest(app)
      .get('/api/test')
      .set('X-Forwarded-For', '203.0.113.10');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    delete process.env.RATE_LIMIT_API_ALLOWLIST;
  });

  test('allowlisted Cloudflare client IPs bypass the API rate limiter when proxy trust is enabled', async () => {
    const app = express();
    app.use(cookieParser());
    app.set('trust proxy', 1);
    app.use('/api', createApiLimiter({
      windowMs: 60 * 1000,
      max: 1,
    }));
    app.get('/api/test', (_req, res) => {
      res.json({ ok: true });
    });

    process.env.RATE_LIMIT_API_ALLOWLIST = '203.0.113.10';

    const { default: supertest } = await import('supertest');
    const first = await supertest(app)
      .get('/api/test')
      .set('CF-Connecting-IP', '203.0.113.10');

    const second = await supertest(app)
      .get('/api/test')
      .set('CF-Connecting-IP', '203.0.113.10');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    delete process.env.RATE_LIMIT_API_ALLOWLIST;
  });
});
