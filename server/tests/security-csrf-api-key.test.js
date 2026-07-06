import { jest, describe, test, expect, beforeAll, afterEach } from '@jest/globals';

const mockResponse = {
  forbidden: jest.fn((res, msg) => res.status(403).json({ error: msg }))
};

jest.unstable_mockModule('../utils/response.js', () => mockResponse);

let csrfProtection;

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

beforeAll(async () => {
  const mod = await import('../middleware/security.js');
  csrfProtection = mod.csrfProtection;
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('csrfProtection', () => {
  test('skips CSRF validation for Cavendo Bearer API key requests', () => {
    const req = {
      method: 'POST',
      path: '/api/workflows/1',
      headers: {
        authorization: 'Bearer cav_uk_123'
      },
      cookies: {
        session: 'existing-session',
      }
    };
    const res = mockRes();
    const next = jest.fn();

    csrfProtection(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockResponse.forbidden).not.toHaveBeenCalled();
  });
});
