import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { internalServiceAuthProbe } from '../middleware/internalServiceAuth.js';

const OLD_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

describe('internalServiceAuthProbe', () => {
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = 'test-token-123';
  });

  afterEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = OLD_TOKEN;
  });

  test('authenticates valid token and normalizes actor id', async () => {
    const req = {
      headers: {
        authorization: 'Bearer test-token-123',
        'x-internal-service-name': 'workflow_engine'
      }
    };

    const result = await internalServiceAuthProbe(req);
    expect(result.ok).toBe(true);
    expect(result.auth.actorType).toBe('system');
    expect(result.auth.actorId).toBe('system:workflow_engine');
  });

  test('uses fallback service name when header missing', async () => {
    const req = { headers: { authorization: 'Bearer test-token-123' } };
    const result = await internalServiceAuthProbe(req);
    expect(result.ok).toBe(true);
    expect(result.auth.actorId).toBe('system:internal');
  });

  test('rejects invalid service name', async () => {
    const req = {
      headers: {
        authorization: 'Bearer test-token-123',
        'x-internal-service-name': 'Bad Name!'
      }
    };

    const result = await internalServiceAuthProbe(req);
    expect(result.ok).toBe(false);
  });
});
