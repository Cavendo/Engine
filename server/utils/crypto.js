import crypto from 'crypto';
import bcrypt from 'bcrypt';

const API_KEY_PREFIX = process.env.API_KEY_PREFIX || 'cav_ak';
const USER_KEY_PREFIX = 'cav_uk';
const BCRYPT_ROUNDS = 12;

// Encryption settings
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Generate a new API key with prefix
 * @returns {{ key: string, hash: string, prefix: string }}
 */
export function generateApiKey() {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  const key = `${API_KEY_PREFIX}_${randomBytes}`;
  const hash = hashApiKey(key);
  const prefix = key.substring(0, 12); // First 12 chars for identification

  return { key, hash, prefix };
}

/**
 * Hash an API key for storage
 * @param {string} key
 * @returns {string}
 */
export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Generate HMAC signature for webhook payload
 * @param {string} payload
 * @param {string} secret
 * @returns {string}
 */
export function generateWebhookSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify HMAC signature
 * @param {string} payload
 * @param {string} signature
 * @param {string} secret
 * @returns {boolean}
 *
 * TODO: Wire this into any future inbound webhook receiver endpoints.
 * Current webhook flow is outbound-only (Engine signs outgoing deliveries).
 */
export function verifyWebhookSignature(payload, signature, secret) {
  const expected = generateWebhookSignature(payload, secret);
  const sigBuffer = Buffer.from(signature);
  const expBuffer = Buffer.from(expected);
  // VULN-011: timingSafeEqual crashes if buffers differ in length
  if (sigBuffer.length !== expBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, expBuffer);
}

/**
 * Generate a random secret for webhooks
 * @returns {string}
 */
export function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Generate a session token
 * @returns {string}
 */
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash password using bcrypt
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify password against bcrypt hash
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a CSRF token
 * @returns {string}
 */
export function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================
// User API Key Functions
// ============================================

/**
 * Generate a new user API key with prefix
 * @returns {{ key: string, hash: string, prefix: string }}
 */
export function generateUserKey() {
  const randomBytes = crypto.randomBytes(24).toString('base64url');
  const key = `${USER_KEY_PREFIX}_${randomBytes}`;
  const hash = hashApiKey(key);
  const prefix = key.substring(0, 15); // "cav_uk_" + first 8 chars

  return { key, hash, prefix };
}

/**
 * Get the prefix from a user key
 * @param {string} key
 * @returns {string|null}
 */
export function getUserKeyPrefix(key) {
  if (!key || !key.startsWith('cav_uk_')) return null;
  return key.substring(0, 15);
}

// ============================================
// Encryption Keyring
// ============================================

// Cache for resolved keyring and derived keys
let _keyringCache = null;
let _currentVersionCache = null;
let _derivedKeyCache = new Map();

/**
 * Load and parse the encryption keyring from environment.
 * If ENCRYPTION_KEYRING is set, it is the single source of truth.
 * Otherwise, synthesize a v1 keyring from legacy ENCRYPTION_KEY + ENCRYPTION_SALT.
 * @returns {Object} keyring map: { version: { key, salt } }
 */
function loadKeyring() {
  if (_keyringCache) return _keyringCache;

  const keyringEnv = process.env.ENCRYPTION_KEYRING;

  if (keyringEnv) {
    // Warn if legacy vars are also present
    if (process.env.ENCRYPTION_KEY) {
      console.warn('[Crypto] WARNING: ENCRYPTION_KEYRING is set — ENCRYPTION_KEY and ENCRYPTION_SALT are ignored. Remove them to avoid confusion.');
    }

    try {
      const parsed = JSON.parse(keyringEnv);
      if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
        throw new Error('ENCRYPTION_KEYRING must be a non-empty JSON object');
      }
      // Validate each entry has a key
      for (const [ver, entry] of Object.entries(parsed)) {
        if (!entry || !entry.key) {
          throw new Error(`ENCRYPTION_KEYRING version "${ver}" is missing a "key" field`);
        }
      }
      _keyringCache = parsed;
      return _keyringCache;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`ENCRYPTION_KEYRING is not valid JSON: ${err.message}`);
      }
      throw err;
    }
  }

  // Synthesize v1 keyring from legacy env vars
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    _keyringCache = {
      '1': {
        key: envKey,
        salt: process.env.ENCRYPTION_SALT || 'cavendo-dev-salt'
      }
    };
    return _keyringCache;
  }

  // No keyring and no ENCRYPTION_KEY — fail in production
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY or ENCRYPTION_KEYRING environment variable is required in production');
  }

  // Development fallback: derive from session/JWT secret
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('No ENCRYPTION_KEY, ENCRYPTION_KEYRING, SESSION_SECRET, or JWT_SECRET configured');
  }
  console.warn('[Crypto] WARNING: No ENCRYPTION_KEY set, using derived key (development only)');
  _keyringCache = {
    '1': {
      key: secret,
      salt: process.env.ENCRYPTION_SALT || 'cavendo-dev-salt'
    }
  };
  return _keyringCache;
}

/**
 * Get the current key version for new encryptions.
 * @returns {number}
 */
function getCurrentKeyVersion() {
  if (_currentVersionCache !== null) return _currentVersionCache;

  const explicit = process.env.ENCRYPTION_KEY_VERSION_CURRENT;
  if (explicit) {
    _currentVersionCache = parseInt(explicit, 10);
    return _currentVersionCache;
  }

  // Default: highest version in keyring, or 1 for legacy
  const keyring = loadKeyring();
  const versions = Object.keys(keyring).map(Number).sort((a, b) => a - b);
  _currentVersionCache = versions[versions.length - 1] || 1;
  return _currentVersionCache;
}

/**
 * Derive or resolve the AES-256 key buffer for a given keyring version.
 * Hex 32-byte keys pass through directly; otherwise scrypt-derived from passphrase + salt.
 * @param {number|string} version
 * @returns {Buffer}
 */
function getKeyByVersion(version) {
  const vStr = String(version);
  if (_derivedKeyCache.has(vStr)) return _derivedKeyCache.get(vStr);

  const keyring = loadKeyring();
  const entry = keyring[vStr];
  if (!entry) {
    throw new Error(`Encryption key version ${version} not found in keyring`);
  }

  let keyBuffer;
  // Try to interpret as hex 32-byte key
  const hexBuffer = Buffer.from(entry.key, 'hex');
  if (hexBuffer.length === KEY_LENGTH && /^[0-9a-fA-F]{64}$/.test(entry.key)) {
    keyBuffer = hexBuffer;
  } else {
    // Derive from passphrase + salt
    const salt = entry.salt || 'cavendo-dev-salt';
    keyBuffer = crypto.scryptSync(entry.key, salt, KEY_LENGTH);
  }

  _derivedKeyCache.set(vStr, keyBuffer);
  return keyBuffer;
}

/**
 * Get or derive encryption key from environment (legacy API — resolves to v1 or current version)
 * @returns {Buffer}
 */
function getEncryptionKey() {
  return getKeyByVersion(getCurrentKeyVersion());
}

/**
 * Reset the keyring cache (for testing purposes)
 */
export function _resetKeyringCache() {
  _keyringCache = null;
  _currentVersionCache = null;
  _derivedKeyCache = new Map();
}

// ============================================
// Encryption Functions (for provider API keys)
// ============================================

/**
 * Encrypt a string value using AES-256-GCM with the current key version.
 * @param {string} plaintext
 * @returns {{ encrypted: string, iv: string, keyVersion: number } | { encrypted: null, iv: null, keyVersion: null }}
 */
export function encrypt(plaintext) {
  if (!plaintext) return { encrypted: null, iv: null, keyVersion: null };

  const keyVersion = getCurrentKeyVersion();
  const key = getKeyByVersion(keyVersion);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([
    Buffer.from(encrypted, 'base64'),
    authTag
  ]).toString('base64');

  return {
    encrypted: combined,
    iv: iv.toString('base64'),
    keyVersion
  };
}

/**
 * Decrypt a string value using AES-256-GCM.
 * @param {string} encryptedData - Base64 encoded encrypted value (includes auth tag)
 * @param {string} ivBase64 - Base64 encoded IV
 * @param {number|null} [keyVersion=null] - Key version used for encryption. Defaults to 1 (legacy).
 * @returns {string|null}
 */
export function decrypt(encryptedData, ivBase64, keyVersion = null) {
  if (!encryptedData || !ivBase64) return null;

  // Resolve version: null/undefined → legacy v1
  const resolvedVersion = (keyVersion != null) ? keyVersion : 1;

  try {
    const key = getKeyByVersion(resolvedVersion);
    const iv = Buffer.from(ivBase64, 'base64');

    const combined = Buffer.from(encryptedData, 'base64');
    const encrypted = combined.slice(0, combined.length - AUTH_TAG_LENGTH);
    const authTag = combined.slice(combined.length - AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    console.error(`[Crypto] Decryption failed (keyVersion=${resolvedVersion}):`, err.message);
    return null;
  }
}

/**
 * Check if encrypted data can be decrypted with a given key version.
 * Returns boolean, never throws.
 * @param {string} encryptedData
 * @param {string} ivBase64
 * @param {number|null} keyVersion
 * @returns {boolean}
 */
export function canDecrypt(encryptedData, ivBase64, keyVersion) {
  try {
    const result = decrypt(encryptedData, ivBase64, keyVersion);
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Run a health check on all encrypted rows in the database.
 * Scans agents and storage_connections tables.
 * @param {object} db - Database adapter with .many() and .one() methods
 * @returns {Promise<{ ok: boolean, total: number, failed: number, details: Array, truncated: boolean, keyVersions: Object, currentVersion: number }>}
 */
export async function runCryptoHealthCheck(db) {
  const details = [];
  const MAX_DETAILS = 500;
  let total = 0;
  let failed = 0;
  let truncated = false;
  const keyVersionCounts = {};
  const currentVersion = getCurrentKeyVersion();

  // Check agents with encrypted provider keys
  try {
    const agents = await db.many(`
      SELECT id, provider_api_key_encrypted, provider_api_key_iv, encryption_key_version
      FROM agents
      WHERE provider_api_key_encrypted IS NOT NULL
    `);

    for (const agent of agents) {
      total++;
      const ver = agent.encryption_key_version ?? 1;
      keyVersionCounts[ver] = (keyVersionCounts[ver] || 0) + 1;

      if (!canDecrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv, ver)) {
        failed++;
        if (details.length < MAX_DETAILS) {
          details.push({
            table: 'agents',
            id: agent.id,
            column: 'provider_api_key_encrypted',
            keyVersion: ver,
            error: 'decryption_failed'
          });
        } else {
          truncated = true;
        }
      }
    }
  } catch (err) {
    // Table might not have the column yet (pre-migration)
    if (!err.message.includes('no such column')) {
      throw err;
    }
    // Fall back to checking without version column
    const agents = await db.many(`
      SELECT id, provider_api_key_encrypted, provider_api_key_iv
      FROM agents
      WHERE provider_api_key_encrypted IS NOT NULL
    `);

    for (const agent of agents) {
      total++;
      const ver = 1;
      keyVersionCounts[ver] = (keyVersionCounts[ver] || 0) + 1;

      if (!canDecrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv, ver)) {
        failed++;
        if (details.length < MAX_DETAILS) {
          details.push({
            table: 'agents',
            id: agent.id,
            column: 'provider_api_key_encrypted',
            keyVersion: ver,
            error: 'decryption_failed'
          });
        } else {
          truncated = true;
        }
      }
    }
  }

  // Check storage connections
  try {
    const conns = await db.many(`
      SELECT id,
        access_key_id_encrypted, access_key_id_iv, access_key_id_key_version,
        secret_access_key_encrypted, secret_access_key_iv, secret_access_key_key_version
      FROM storage_connections
      WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL
    `);

    for (const conn of conns) {
      // Check access key
      if (conn.access_key_id_encrypted) {
        total++;
        const ver = conn.access_key_id_key_version ?? 1;
        keyVersionCounts[ver] = (keyVersionCounts[ver] || 0) + 1;

        if (!canDecrypt(conn.access_key_id_encrypted, conn.access_key_id_iv, ver)) {
          failed++;
          if (details.length < MAX_DETAILS) {
            details.push({
              table: 'storage_connections',
              id: conn.id,
              column: 'access_key_id_encrypted',
              keyVersion: ver,
              error: 'decryption_failed'
            });
          } else {
            truncated = true;
          }
        }
      }

      // Check secret key
      if (conn.secret_access_key_encrypted) {
        total++;
        const ver = conn.secret_access_key_key_version ?? 1;
        keyVersionCounts[ver] = (keyVersionCounts[ver] || 0) + 1;

        if (!canDecrypt(conn.secret_access_key_encrypted, conn.secret_access_key_iv, ver)) {
          failed++;
          if (details.length < MAX_DETAILS) {
            details.push({
              table: 'storage_connections',
              id: conn.id,
              column: 'secret_access_key_encrypted',
              keyVersion: ver,
              error: 'decryption_failed'
            });
          } else {
            truncated = true;
          }
        }
      }
    }
  } catch (err) {
    if (!err.message.includes('no such column')) {
      throw err;
    }
    // Fall back to checking without version columns
    const conns = await db.many(`
      SELECT id, access_key_id_encrypted, access_key_id_iv,
        secret_access_key_encrypted, secret_access_key_iv
      FROM storage_connections
      WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL
    `);

    for (const conn of conns) {
      if (conn.access_key_id_encrypted) {
        total++;
        keyVersionCounts[1] = (keyVersionCounts[1] || 0) + 1;
        if (!canDecrypt(conn.access_key_id_encrypted, conn.access_key_id_iv, 1)) {
          failed++;
          if (details.length < MAX_DETAILS) {
            details.push({ table: 'storage_connections', id: conn.id, column: 'access_key_id_encrypted', keyVersion: 1, error: 'decryption_failed' });
          } else { truncated = true; }
        }
      }
      if (conn.secret_access_key_encrypted) {
        total++;
        keyVersionCounts[1] = (keyVersionCounts[1] || 0) + 1;
        if (!canDecrypt(conn.secret_access_key_encrypted, conn.secret_access_key_iv, 1)) {
          failed++;
          if (details.length < MAX_DETAILS) {
            details.push({ table: 'storage_connections', id: conn.id, column: 'secret_access_key_encrypted', keyVersion: 1, error: 'decryption_failed' });
          } else { truncated = true; }
        }
      }
    }
  }

  return {
    ok: failed === 0,
    total,
    failed,
    details,
    truncated,
    keyVersions: keyVersionCounts,
    currentVersion
  };
}

/**
 * Test if encryption is working properly
 * @returns {boolean}
 */
export function testEncryption() {
  try {
    const testValue = 'test-encryption-' + Date.now();
    const { encrypted, iv, keyVersion } = encrypt(testValue);
    const decrypted = decrypt(encrypted, iv, keyVersion);
    return decrypted === testValue;
  } catch (err) {
    console.error('[Crypto] Encryption test failed:', err.message);
    return false;
  }
}
