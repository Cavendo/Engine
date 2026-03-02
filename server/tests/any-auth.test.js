import { describe, test, expect, jest } from '@jest/globals';
import { anyAuth } from '../middleware/anyAuth.js';

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((payload) => {
      res.body = payload;
      return res;
    })
  };
  return res;
}

describe('anyAuth', () => {
  test('returns exactly one 401 when all probes fail', async () => {
    const probeA = jest.fn(async () => ({ ok: false }));
    const probeB = jest.fn(async () => ({ ok: false }));
    const middleware = anyAuth([probeA, probeB]);

    const req = { headers: {}, cookies: {} };
    const res = createRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(probeA).toHaveBeenCalledTimes(1);
    expect(probeB).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('short-circuits on first successful probe', async () => {
    const probeA = jest.fn(async () => ({
      ok: true,
      auth: { type: 'user', actorType: 'user', actorId: 'user:1' },
      user: { id: 1, role: 'admin' }
    }));
    const probeB = jest.fn(async () => ({ ok: false }));
    const middleware = anyAuth([probeA, probeB]);

    const req = { headers: {}, cookies: {} };
    const res = createRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(probeA).toHaveBeenCalledTimes(1);
    expect(probeB).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth.actorId).toBe('user:1');
    expect(req.user.id).toBe(1);
  });
});
