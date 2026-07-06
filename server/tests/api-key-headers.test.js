import { describe, expect, test } from '@jest/globals';
import { extractApiKeyFromRequest, isCavendoApiKey } from '../utils/apiKeyHeaders.js';

describe('apiKeyHeaders', () => {
  test('prefers X-Agent-Key when present', () => {
    const req = {
      headers: {
        'x-agent-key': 'cav_uk_direct',
        'x-api-key': 'cav_uk_secondary',
        authorization: 'Bearer cav_uk_bearer'
      }
    };

    expect(extractApiKeyFromRequest(req)).toBe('cav_uk_direct');
  });

  test('accepts X-API-Key values directly', () => {
    const req = {
      headers: {
        'x-api-key': 'cav_uk_header'
      }
    };

    expect(extractApiKeyFromRequest(req)).toBe('cav_uk_header');
  });

  test('accepts Bearer auth for Cavendo API keys', () => {
    const req = {
      headers: {
        authorization: 'Bearer cav_ak_bearer'
      }
    };

    expect(extractApiKeyFromRequest(req)).toBe('cav_ak_bearer');
  });

  test('ignores non-Cavendo bearer tokens', () => {
    const req = {
      headers: {
        authorization: 'Bearer not-a-cavendo-token'
      }
    };

    expect(extractApiKeyFromRequest(req)).toBe('');
  });

  test('detects valid Cavendo key prefixes', () => {
    expect(isCavendoApiKey('cav_uk_123')).toBe(true);
    expect(isCavendoApiKey('cav_ak_123')).toBe(true);
    expect(isCavendoApiKey('Bearer cav_uk_123')).toBe(false);
    expect(isCavendoApiKey('other')).toBe(false);
  });
});
