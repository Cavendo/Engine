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
 */
export function verifyWebhookSignature(payload, signature, secret) {
  const expected = generateWebhookSignature(payload, secret);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
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
// Encryption Functions (for provider API keys)
// ============================================

/**
 * Get or derive encryption key from environment
 * @returns {Buffer}
 */
function getEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;

  if (envKey) {
    const keyBuffer = Buffer.from(envKey, 'hex');
    if (keyBuffer.length === KEY_LENGTH) {
      return keyBuffer;
    }
    return crypto.scryptSync(envKey, 'cavendo-salt', KEY_LENGTH);
  }

  // FAIL in production, warn and use fallback only in development
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY environment variable is required in production');
  }

  // Fall back to deriving from a secret (development only)
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('No ENCRYPTION_KEY, SESSION_SECRET, or JWT_SECRET configured');
  }
  console.warn('[Crypto] WARNING: No ENCRYPTION_KEY set, using derived key (development only)');
  return crypto.scryptSync(secret, 'cavendo-salt', KEY_LENGTH);
}

/**
 * Encrypt a string value using AES-256-GCM
 * @param {string} plaintext
 * @returns {{ encrypted: string, iv: string } | { encrypted: null, iv: null }}
 */
export function encrypt(plaintext) {
  if (!plaintext) return { encrypted: null, iv: null };

  const key = getEncryptionKey();
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
    iv: iv.toString('base64')
  };
}

/**
 * Decrypt a string value using AES-256-GCM
 * @param {string} encryptedData - Base64 encoded encrypted value (includes auth tag)
 * @param {string} ivBase64 - Base64 encoded IV
 * @returns {string|null}
 */
export function decrypt(encryptedData, ivBase64) {
  if (!encryptedData || !ivBase64) return null;

  try {
    const key = getEncryptionKey();
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
    console.error('[Crypto] Decryption failed:', err.message);
    return null;
  }
}

/**
 * Test if encryption is working properly
 * @returns {boolean}
 */
export function testEncryption() {
  try {
    const testValue = 'test-encryption-' + Date.now();
    const { encrypted, iv } = encrypt(testValue);
    const decrypted = decrypt(encrypted, iv);
    return decrypted === testValue;
  } catch (err) {
    console.error('[Crypto] Encryption test failed:', err.message);
    return false;
  }
}
