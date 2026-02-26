import { generateWebhookSignature, verifyWebhookSignature, encrypt, decrypt, canDecrypt, testEncryption, runCryptoHealthCheck, _resetKeyringCache } from '../utils/crypto.js';
import { createSqliteAdapter } from '../db/sqliteAdapter.js';

// Helper: set env vars and reset cache
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetKeyringCache();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetKeyringCache();
  }
}

describe('crypto webhook signature verification', () => {
  it('returns true for a valid signature', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const signature = generateWebhookSignature(payload, secret);

    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it('returns false for mismatched signature length (no throw)', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';

    expect(() => verifyWebhookSignature(payload, 'abc', secret)).not.toThrow();
    expect(verifyWebhookSignature(payload, 'abc', secret)).toBe(false);
  });

  it('returns false for invalid signature value with same length', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const badSignature = '0'.repeat(64);

    expect(verifyWebhookSignature(payload, badSignature, secret)).toBe(false);
  });
});

describe('encryption key versioning', () => {
  // Two distinct 32-byte hex keys
  const KEY_V1 = 'a'.repeat(64);
  const KEY_V2 = 'b'.repeat(64);
  const SALT_V1 = 'salt-v1';
  const SALT_V2 = 'salt-v2';

  afterEach(() => {
    _resetKeyringCache();
  });

  describe('legacy single-key mode (backward compat)', () => {
    it('encrypts and decrypts with ENCRYPTION_KEY only', () => {
      withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_SALT: SALT_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, () => {
        const { encrypted, iv, keyVersion } = encrypt('secret-data');
        expect(keyVersion).toBe(1);
        expect(encrypted).toBeTruthy();

        const result = decrypt(encrypted, iv, keyVersion);
        expect(result).toBe('secret-data');
      });
    });

    it('decrypt defaults to v1 when keyVersion is null', () => {
      withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_SALT: SALT_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, () => {
        const { encrypted, iv } = encrypt('legacy-data');
        // Simulates pre-migration rows with no version stored
        const result = decrypt(encrypted, iv, null);
        expect(result).toBe('legacy-data');
      });
    });
  });

  describe('keyring mode', () => {
    const keyring = JSON.stringify({
      '1': { key: KEY_V1, salt: SALT_V1 },
      '2': { key: KEY_V2, salt: SALT_V2 }
    });

    it('encrypts with current version and decrypts with matching version', () => {
      withEnv({
        ENCRYPTION_KEYRING: keyring,
        ENCRYPTION_KEY_VERSION_CURRENT: '2',
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_SALT: undefined
      }, () => {
        const { encrypted, iv, keyVersion } = encrypt('v2-secret');
        expect(keyVersion).toBe(2);

        const result = decrypt(encrypted, iv, 2);
        expect(result).toBe('v2-secret');
      });
    });

    it('decrypts v1 data with v1 key when current is v2', () => {
      // First encrypt with v1
      let encData;
      withEnv({
        ENCRYPTION_KEYRING: keyring,
        ENCRYPTION_KEY_VERSION_CURRENT: '1',
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_SALT: undefined
      }, () => {
        encData = encrypt('v1-secret');
        expect(encData.keyVersion).toBe(1);
      });

      // Now switch current to v2 and decrypt with stored v1
      withEnv({
        ENCRYPTION_KEYRING: keyring,
        ENCRYPTION_KEY_VERSION_CURRENT: '2',
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_SALT: undefined
      }, () => {
        const result = decrypt(encData.encrypted, encData.iv, 1);
        expect(result).toBe('v1-secret');
      });
    });

    it('decrypt fails with wrong version', () => {
      withEnv({
        ENCRYPTION_KEYRING: keyring,
        ENCRYPTION_KEY_VERSION_CURRENT: '1',
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_SALT: undefined
      }, () => {
        const { encrypted, iv } = encrypt('v1-only');
        // Try to decrypt with v2 key — should fail
        const result = decrypt(encrypted, iv, 2);
        expect(result).toBeNull();
      });
    });

    it('throws on unknown key version', () => {
      withEnv({
        ENCRYPTION_KEYRING: keyring,
        ENCRYPTION_KEY_VERSION_CURRENT: '2',
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_SALT: undefined
      }, () => {
        const { encrypted, iv } = encrypt('test');
        // Version 99 doesn't exist
        const result = decrypt(encrypted, iv, 99);
        expect(result).toBeNull();
      });
    });
  });

  describe('passphrase-based key derivation', () => {
    it('derives key from passphrase + salt', () => {
      const keyring = JSON.stringify({
        '1': { key: 'my-passphrase', salt: 'my-salt' }
      });

      withEnv({
        ENCRYPTION_KEYRING: keyring,
        ENCRYPTION_KEY_VERSION_CURRENT: '1',
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_SALT: undefined
      }, () => {
        const { encrypted, iv, keyVersion } = encrypt('passphrase-data');
        expect(keyVersion).toBe(1);

        const result = decrypt(encrypted, iv, 1);
        expect(result).toBe('passphrase-data');
      });
    });

    it('per-version salt resolution works independently', () => {
      const keyring = JSON.stringify({
        '1': { key: 'same-passphrase', salt: 'salt-A' },
        '2': { key: 'same-passphrase', salt: 'salt-B' }
      });

      // Encrypt with v1 (salt-A)
      let encData;
      withEnv({
        ENCRYPTION_KEYRING: keyring,
        ENCRYPTION_KEY_VERSION_CURRENT: '1',
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_SALT: undefined
      }, () => {
        encData = encrypt('test');
      });

      // Decrypt with v2 should fail (different salt → different derived key)
      withEnv({
        ENCRYPTION_KEYRING: keyring,
        ENCRYPTION_KEY_VERSION_CURRENT: '2',
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_SALT: undefined
      }, () => {
        const result = decrypt(encData.encrypted, encData.iv, 2);
        expect(result).toBeNull();

        // But v1 still works
        const result2 = decrypt(encData.encrypted, encData.iv, 1);
        expect(result2).toBe('test');
      });
    });
  });

  describe('canDecrypt', () => {
    it('returns true for valid data', () => {
      withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, () => {
        const { encrypted, iv, keyVersion } = encrypt('check-me');
        expect(canDecrypt(encrypted, iv, keyVersion)).toBe(true);
      });
    });

    it('returns false for invalid data', () => {
      withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, () => {
        expect(canDecrypt('bad-data', 'bad-iv', 1)).toBe(false);
      });
    });

    it('returns false for null inputs', () => {
      expect(canDecrypt(null, null, 1)).toBe(false);
    });

    it('never throws', () => {
      expect(() => canDecrypt('x', 'y', 999)).not.toThrow();
      expect(canDecrypt('x', 'y', 999)).toBe(false);
    });
  });

  describe('encrypt/decrypt edge cases', () => {
    it('encrypt returns nulls for empty input', () => {
      const result = encrypt('');
      expect(result).toEqual({ encrypted: null, iv: null, keyVersion: null });
    });

    it('encrypt returns nulls for null input', () => {
      const result = encrypt(null);
      expect(result).toEqual({ encrypted: null, iv: null, keyVersion: null });
    });

    it('decrypt returns null for null inputs', () => {
      expect(decrypt(null, null)).toBeNull();
      expect(decrypt('something', null)).toBeNull();
      expect(decrypt(null, 'something')).toBeNull();
    });
  });

  describe('testEncryption', () => {
    it('returns true when encryption is configured', () => {
      withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, () => {
        expect(testEncryption()).toBe(true);
      });
    });
  });

  describe('runCryptoHealthCheck', () => {
    let Database;
    let db;
    let adapter;

    beforeAll(async () => {
      Database = (await import('better-sqlite3')).default;
    });

    beforeEach(() => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      // Minimal schema for health check
      db.exec(`
        CREATE TABLE agents (
          id INTEGER PRIMARY KEY,
          provider_api_key_encrypted TEXT,
          provider_api_key_iv TEXT,
          encryption_key_version INTEGER
        );
        CREATE TABLE storage_connections (
          id INTEGER PRIMARY KEY,
          access_key_id_encrypted TEXT,
          access_key_id_iv TEXT,
          access_key_id_key_version INTEGER,
          secret_access_key_encrypted TEXT,
          secret_access_key_iv TEXT,
          secret_access_key_key_version INTEGER
        );
      `);
      adapter = createSqliteAdapter(db);
    });

    afterEach(() => {
      db.close();
    });

    it('returns ok for empty database', async () => {
      await withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, async () => {
        const result = await runCryptoHealthCheck(adapter);
        expect(result.ok).toBe(true);
        expect(result.total).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.details).toEqual([]);
        expect(result.currentVersion).toBe(1);
      });
    });

    it('returns ok for correctly encrypted rows', async () => {
      await withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, async () => {
        const { encrypted, iv, keyVersion } = encrypt('test-key');
        db.prepare('INSERT INTO agents (id, provider_api_key_encrypted, provider_api_key_iv, encryption_key_version) VALUES (?, ?, ?, ?)').run(1, encrypted, iv, keyVersion);

        const result = await runCryptoHealthCheck(adapter);
        expect(result.ok).toBe(true);
        expect(result.total).toBe(1);
        expect(result.failed).toBe(0);
      });
    });

    it('reports failures for unreadable encrypted rows', async () => {
      await withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, async () => {
        // Insert a row with garbage encrypted data
        db.prepare('INSERT INTO agents (id, provider_api_key_encrypted, provider_api_key_iv, encryption_key_version) VALUES (?, ?, ?, ?)').run(1, 'garbage', 'garbage', 1);

        const result = await runCryptoHealthCheck(adapter);
        expect(result.ok).toBe(false);
        expect(result.total).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.details).toHaveLength(1);
        expect(result.details[0]).toMatchObject({
          table: 'agents',
          id: 1,
          column: 'provider_api_key_encrypted',
          keyVersion: 1,
          error: 'decryption_failed'
        });
      });
    });

    it('checks storage_connections correctly', async () => {
      await withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, async () => {
        const ak = encrypt('access-key');
        const sk = encrypt('secret-key');
        db.prepare(`
          INSERT INTO storage_connections (id, access_key_id_encrypted, access_key_id_iv, access_key_id_key_version, secret_access_key_encrypted, secret_access_key_iv, secret_access_key_key_version)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(1, ak.encrypted, ak.iv, ak.keyVersion, sk.encrypted, sk.iv, sk.keyVersion);

        const result = await runCryptoHealthCheck(adapter);
        expect(result.ok).toBe(true);
        expect(result.total).toBe(2); // Two encrypted columns
      });
    });

    it('returns correct shape', async () => {
      await withEnv({
        ENCRYPTION_KEY: KEY_V1,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, async () => {
        const result = await runCryptoHealthCheck(adapter);
        expect(result).toHaveProperty('ok');
        expect(result).toHaveProperty('total');
        expect(result).toHaveProperty('failed');
        expect(result).toHaveProperty('details');
        expect(result).toHaveProperty('truncated');
        expect(result).toHaveProperty('keyVersions');
        expect(result).toHaveProperty('currentVersion');
        expect(typeof result.ok).toBe('boolean');
        expect(typeof result.total).toBe('number');
        expect(typeof result.failed).toBe('number');
        expect(Array.isArray(result.details)).toBe(true);
        expect(typeof result.truncated).toBe('boolean');
      });
    });
  });

  describe('keyring precedence', () => {
    it('ENCRYPTION_KEYRING overrides ENCRYPTION_KEY', () => {
      const KEY_A = 'c'.repeat(64);
      const KEY_B = 'd'.repeat(64);

      // Encrypt with keyring key
      let encData;
      withEnv({
        ENCRYPTION_KEYRING: JSON.stringify({ '1': { key: KEY_A, salt: 's' } }),
        ENCRYPTION_KEY_VERSION_CURRENT: '1',
        ENCRYPTION_KEY: KEY_B, // Should be ignored
        ENCRYPTION_SALT: 's'
      }, () => {
        encData = encrypt('keyring-wins');
      });

      // Decrypt with keyring key should work
      withEnv({
        ENCRYPTION_KEYRING: JSON.stringify({ '1': { key: KEY_A, salt: 's' } }),
        ENCRYPTION_KEY_VERSION_CURRENT: '1',
        ENCRYPTION_KEY: KEY_B,
        ENCRYPTION_SALT: 's'
      }, () => {
        expect(decrypt(encData.encrypted, encData.iv, 1)).toBe('keyring-wins');
      });

      // Decrypt with ENCRYPTION_KEY alone (KEY_B) should fail
      withEnv({
        ENCRYPTION_KEY: KEY_B,
        ENCRYPTION_SALT: 's',
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_KEY_VERSION_CURRENT: undefined
      }, () => {
        expect(decrypt(encData.encrypted, encData.iv, 1)).toBeNull();
      });
    });
  });
});
