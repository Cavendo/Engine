/**
 * Tests for provider endpoint validation and security
 * Covers: URL policy, origin-only enforcement, resolveBaseUrl, auth header behavior
 */

import { jest } from '@jest/globals';

// Mock dns before importing
const mockResolve4 = jest.fn();
const mockResolve6 = jest.fn();
jest.unstable_mockModule('dns/promises', () => ({
  default: { resolve4: mockResolve4, resolve6: mockResolve6 },
  resolve4: mockResolve4,
  resolve6: mockResolve6,
}));

// Dynamic import after mocking
const { validateProviderBaseUrl, resolveBaseUrl } = await import('../utils/providerEndpoint.js');
const { isPrivateOrLocalIp, isLocalHostname } = await import('../utils/networkUtils.js');

// Helper to set env vars for a test then restore
function withEnv(vars, fn) {
  return async () => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

beforeEach(() => {
  mockResolve4.mockReset();
  mockResolve6.mockReset();
  // Default: localhost resolves to 127.0.0.1
  mockResolve4.mockRejectedValue(new Error('ENOTFOUND'));
  mockResolve6.mockRejectedValue(new Error('ENOTFOUND'));
  // Clean env
  delete process.env.ALLOW_CUSTOM_PROVIDER_BASE_URLS;
  delete process.env.PROVIDER_BASE_URL_ALLOWLIST;
  delete process.env.OPENAI_COMPAT_DEFAULT_BASE_URL;
});

// ============================================
// networkUtils tests
// ============================================

describe('isPrivateOrLocalIp', () => {
  test('detects 127.x loopback', () => {
    expect(isPrivateOrLocalIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('127.0.0.2')).toBe(true);
  });

  test('detects 10.x private', () => {
    expect(isPrivateOrLocalIp('10.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('10.255.255.255')).toBe(true);
  });

  test('detects 172.16-31.x private', () => {
    expect(isPrivateOrLocalIp('172.16.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('172.31.255.255')).toBe(true);
    expect(isPrivateOrLocalIp('172.15.0.1')).toBe(false);
    expect(isPrivateOrLocalIp('172.32.0.1')).toBe(false);
  });

  test('detects 192.168.x private', () => {
    expect(isPrivateOrLocalIp('192.168.1.1')).toBe(true);
  });

  test('detects IPv6 loopback', () => {
    expect(isPrivateOrLocalIp('::1')).toBe(true);
  });

  test('detects IPv6 link-local', () => {
    expect(isPrivateOrLocalIp('fe80::1')).toBe(true);
  });

  test('detects IPv6 unique local', () => {
    expect(isPrivateOrLocalIp('fd12::1')).toBe(true);
    expect(isPrivateOrLocalIp('fc00::1')).toBe(true);
  });

  test('allows public IPs', () => {
    expect(isPrivateOrLocalIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrLocalIp('1.2.3.4')).toBe(false);
  });

  test('handles null/empty', () => {
    expect(isPrivateOrLocalIp(null)).toBe(false);
    expect(isPrivateOrLocalIp('')).toBe(false);
  });
});

describe('isLocalHostname', () => {
  test('detects localhost variants', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('127.0.0.1')).toBe(true);
    expect(isLocalHostname('::1')).toBe(true);
    expect(isLocalHostname('[::1]')).toBe(true);
    expect(isLocalHostname('0.0.0.0')).toBe(true);
  });

  test('rejects non-local hostnames', () => {
    expect(isLocalHostname('example.com')).toBe(false);
    expect(isLocalHostname('myserver.local')).toBe(false);
  });
});

// ============================================
// Origin-only enforcement tests
// ============================================

describe('validateProviderBaseUrl — origin-only enforcement', () => {
  test('accepts bare origin', async () => {
    const result = await validateProviderBaseUrl('http://localhost:11434');
    expect(result.valid).toBe(true);
    expect(result.normalizedUrl).toBe('http://localhost:11434');
  });

  test('accepts and normalizes trailing slash', async () => {
    const result = await validateProviderBaseUrl('http://localhost:11434/');
    expect(result.valid).toBe(true);
    expect(result.normalizedUrl).toBe('http://localhost:11434');
  });

  test('rejects URL with path', async () => {
    const result = await validateProviderBaseUrl('http://localhost:11434/v1/chat/completions');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/path/i);
  });

  test('rejects URL with query string', async () => {
    const result = await validateProviderBaseUrl('http://localhost:11434?foo=bar');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/query/i);
  });

  test('rejects URL with fragment', async () => {
    const result = await validateProviderBaseUrl('http://localhost:11434#section');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/fragment/i);
  });

  test('rejects non-http protocols', async () => {
    const result = await validateProviderBaseUrl('ftp://localhost:11434');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/protocol/i);
  });

  test('rejects invalid URLs', async () => {
    const result = await validateProviderBaseUrl('not-a-url');
    expect(result.valid).toBe(false);
  });

  test('rejects null/empty', async () => {
    expect((await validateProviderBaseUrl(null)).valid).toBe(false);
    expect((await validateProviderBaseUrl('')).valid).toBe(false);
  });
});

// ============================================
// URL policy matrix tests
// ============================================

describe('validateProviderBaseUrl — default mode (local only)', () => {
  test('allows local http://localhost:11434', async () => {
    const result = await validateProviderBaseUrl('http://localhost:11434');
    expect(result.valid).toBe(true);
  });

  test('allows local http://127.0.0.1:8000', async () => {
    const result = await validateProviderBaseUrl('http://127.0.0.1:8000');
    expect(result.valid).toBe(true);
  });

  test('blocks remote http://remote.example.com:8080', async () => {
    mockResolve4.mockResolvedValue(['203.0.113.1']);
    const result = await validateProviderBaseUrl('http://remote.example.com:8080');
    expect(result.valid).toBe(false);
  });

  test('blocks remote https://remote.example.com:8080', async () => {
    mockResolve4.mockResolvedValue(['203.0.113.1']);
    const result = await validateProviderBaseUrl('https://remote.example.com:8080');
    expect(result.valid).toBe(false);
  });
});

describe('validateProviderBaseUrl — override mode', () => {
  test('allows remote https in override mode', withEnv(
    { ALLOW_CUSTOM_PROVIDER_BASE_URLS: 'true' },
    async () => {
      mockResolve4.mockResolvedValue(['203.0.113.1']);
      const result = await validateProviderBaseUrl('https://remote.example.com:8080');
      expect(result.valid).toBe(true);
    }
  ));

  test('blocks remote http in override mode', withEnv(
    { ALLOW_CUSTOM_PROVIDER_BASE_URLS: 'true' },
    async () => {
      mockResolve4.mockResolvedValue(['203.0.113.1']);
      const result = await validateProviderBaseUrl('http://remote.example.com');
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/HTTPS/);
    }
  ));
});

describe('validateProviderBaseUrl — allowlist', () => {
  test('allows allowlisted host in default mode', withEnv(
    { PROVIDER_BASE_URL_ALLOWLIST: 'gpu-box.lan' },
    async () => {
      mockResolve4.mockResolvedValue(['203.0.113.1']);
      const result = await validateProviderBaseUrl('http://gpu-box.lan:11434');
      expect(result.valid).toBe(true);
    }
  ));

  test('allows port-specific allowlist match', withEnv(
    { PROVIDER_BASE_URL_ALLOWLIST: 'gpu-box.lan:11434' },
    async () => {
      mockResolve4.mockResolvedValue(['203.0.113.1']);
      const result = await validateProviderBaseUrl('http://gpu-box.lan:11434');
      expect(result.valid).toBe(true);
    }
  ));

  test('allows IPv6 allowlist entry with bracket notation', withEnv(
    { PROVIDER_BASE_URL_ALLOWLIST: '[fd12::1]:8080' },
    async () => {
      // URL.hostname for http://[fd12::1]:8080 is "fd12::1" (unbracketed)
      // Allowlist stores unbracketed too, so they should match
      const result = await validateProviderBaseUrl('http://[fd12::1]:8080');
      expect(result.valid).toBe(true);
    }
  ));

  test('allows IPv6 allowlist entry without port', withEnv(
    { PROVIDER_BASE_URL_ALLOWLIST: '[::1]' },
    async () => {
      const result = await validateProviderBaseUrl('http://[::1]:11434');
      expect(result.valid).toBe(true);
    }
  ));
});

describe('validateProviderBaseUrl — DNS split-horizon prevention', () => {
  test('treats mixed public/private DNS as non-local', async () => {
    mockResolve4.mockResolvedValue(['192.168.1.1', '203.0.113.1']);
    const result = await validateProviderBaseUrl('http://split-dns.example.com');
    expect(result.valid).toBe(false);
  });

  test('treats DNS failure as non-local', async () => {
    mockResolve4.mockRejectedValue(new Error('ENOTFOUND'));
    mockResolve6.mockRejectedValue(new Error('ENOTFOUND'));
    const result = await validateProviderBaseUrl('http://no-records.example.com');
    expect(result.valid).toBe(false);
  });
});

// ============================================
// resolveBaseUrl tests
// ============================================

describe('resolveBaseUrl', () => {
  test('openai_compatible with saved URL returns saved URL', () => {
    const agent = { provider: 'openai_compatible', provider_base_url: 'http://localhost:8000' };
    expect(resolveBaseUrl(agent)).toBe('http://localhost:8000');
  });

  test('openai_compatible with null URL returns default', () => {
    const agent = { provider: 'openai_compatible', provider_base_url: null };
    expect(resolveBaseUrl(agent)).toBe('http://localhost:11434');
  });

  test('openai_compatible with empty URL returns default', () => {
    const agent = { provider: 'openai_compatible', provider_base_url: '' };
    expect(resolveBaseUrl(agent)).toBe('http://localhost:11434');
  });

  test('openai_compatible respects OPENAI_COMPAT_DEFAULT_BASE_URL env', withEnv(
    { OPENAI_COMPAT_DEFAULT_BASE_URL: 'http://localhost:9999' },
    async () => {
      const agent = { provider: 'openai_compatible', provider_base_url: null };
      expect(resolveBaseUrl(agent)).toBe('http://localhost:9999');
    }
  ));

  test('openai returns null', () => {
    const agent = { provider: 'openai', provider_base_url: null };
    expect(resolveBaseUrl(agent)).toBe(null);
  });

  test('anthropic returns null', () => {
    const agent = { provider: 'anthropic', provider_base_url: null };
    expect(resolveBaseUrl(agent)).toBe(null);
  });
});
