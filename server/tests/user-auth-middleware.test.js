import { jest, describe, test, expect, beforeAll, afterEach } from '@jest/globals';

const mockDb = {
  one: jest.fn(),
  exec: jest.fn()
};

const mockResponse = {
  unauthorized: jest.fn((res, msg) => res.status(401).json({ error: msg })),
  forbidden: jest.fn((res, msg) => res.status(403).json({ error: msg }))
};

jest.unstable_mockModule('../db/adapter.js', () => ({
  default: mockDb
}));

jest.unstable_mockModule('../utils/crypto.js', () => ({
  hashSessionToken: jest.fn((token) => `hash:${token}`)
}));

jest.unstable_mockModule('../utils/response.js', () => mockResponse);

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    clearCookie: jest.fn()
  };
}

let userAuth, optionalUserAuth;

beforeAll(async () => {
  const mod = await import('../middleware/userAuth.js');
  userAuth = mod.userAuth;
  optionalUserAuth = mod.optionalUserAuth;
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('userAuth middleware', () => {
  test('rejects when session cookie is missing', async () => {
    const req = { cookies: {} };
    const res = mockRes();
    const next = jest.fn();

    await userAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockResponse.unauthorized).toHaveBeenCalledWith(res, 'Session required');
  });

  test('authenticates a valid session and touches activity timestamp', async () => {
    mockDb.one.mockResolvedValueOnce({
      session_id: 'sess-1',
      token_hash: 'hash:abc',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      last_activity_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      revoked_at: null,
      user_id: 7,
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      status: 'active',
      force_password_change: 0
    });
    mockDb.exec.mockResolvedValue({ changes: 1 });

    const req = { cookies: { session: 'abc' } };
    const res = mockRes();
    const next = jest.fn();

    await userAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({
      id: 7,
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      forcePasswordChange: false
    });
    expect(req.session).toEqual({ id: 'sess-1' });
    expect(mockDb.one).toHaveBeenCalledWith(
      expect.stringContaining('WHERE s.token_hash = ? OR (s.token_hash IS NULL AND s.id = ?)'),
      ['hash:abc', 'abc']
    );
    expect(mockDb.exec).toHaveBeenCalledWith(
      "UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?",
      ['sess-1']
    );
  });

  test('expires session when revoked and clears cookie', async () => {
    mockDb.one.mockResolvedValueOnce({
      session_id: 'sess-2',
      token_hash: 'hash:def',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      last_activity_at: new Date().toISOString(),
      revoked_at: new Date().toISOString(),
      user_id: 8,
      email: 'reviewer@example.com',
      name: 'Reviewer',
      role: 'reviewer',
      status: 'active',
      force_password_change: 0
    });
    mockDb.exec.mockResolvedValue({ changes: 1 });

    const req = { cookies: { session: 'def' } };
    const res = mockRes();
    const next = jest.fn();

    await userAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockDb.exec).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM sessions'),
      ['hash:def', 'def']
    );
    expect(res.clearCookie).toHaveBeenCalledWith('session');
    expect(mockResponse.unauthorized).toHaveBeenCalledWith(res, 'Session expired');
  });
});

describe('optionalUserAuth middleware', () => {
  test('no-ops when cookie is missing', async () => {
    const req = { cookies: {} };
    const res = mockRes();
    const next = jest.fn();

    await optionalUserAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockDb.one).not.toHaveBeenCalled();
  });

  test('attaches user when session is valid', async () => {
    mockDb.one.mockResolvedValueOnce({
      session_id: 'sess-3',
      token_hash: 'hash:ghi',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      last_activity_at: new Date().toISOString(),
      revoked_at: null,
      user_id: 10,
      email: 'user@example.com',
      name: 'User',
      role: 'reviewer',
      status: 'active',
      force_password_change: 1
    });

    const req = { cookies: { session: 'ghi' } };
    const res = mockRes();
    const next = jest.fn();

    await optionalUserAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({
      id: 10,
      email: 'user@example.com',
      name: 'User',
      role: 'reviewer',
      forcePasswordChange: true
    });
    expect(req.session).toEqual({ id: 'sess-3' });
  });
});
