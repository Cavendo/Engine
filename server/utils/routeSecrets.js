import { decrypt, encrypt } from './crypto.js';

const MARKER = '__cavendo_encrypted_destination_config_v1';

export function encryptDestinationConfig(config) {
  if (config === null || config === undefined) return config;
  if (config?.[MARKER]) return config;
  const { encrypted, iv, keyVersion } = encrypt(JSON.stringify(config));
  if (!encrypted || !iv) throw new Error('Unable to encrypt route destination configuration');
  return { [MARKER]: true, encrypted, iv, keyVersion };
}

export function decryptDestinationConfig(config) {
  if (!config || typeof config !== 'object' || !config[MARKER]) return config || {};
  const plaintext = decrypt(config.encrypted, config.iv, config.keyVersion);
  if (plaintext === null) throw new Error('Unable to decrypt route destination configuration');
  const parsed = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Route destination configuration is invalid');
  }
  return parsed;
}

/** Encrypt legacy JSON route configurations in place after an upgrade. */
export async function migrateRouteDestinationSecrets(db) {
  const routes = await db.many('SELECT id, destination_config FROM routes');
  let migrated = 0;
  for (const route of routes) {
    let config;
    try { config = JSON.parse(route.destination_config || '{}'); } catch { continue; }
    if (config?.[MARKER]) continue;
    await db.exec('UPDATE routes SET destination_config = ? WHERE id = ?', [
      JSON.stringify(encryptDestinationConfig(config)), route.id
    ]);
    migrated += 1;
  }
  return migrated;
}
