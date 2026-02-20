#!/usr/bin/env node
/**
 * Crypto Rotation Script — re-encrypts all encrypted values with the current key version.
 *
 * Safety controls:
 *   --dry-run   (default) Preview what would change without writing
 *   --apply     Actually perform the re-encryption
 *   --force     Re-encrypt rows already on current version
 *   --limit N   Cap rows processed per run
 *   --table T   Restrict to a single table (agents or storage_connections)
 *
 * Machine-readable JSON summary to stdout.
 *
 * Exit codes:
 *   0 = success (or dry-run complete)
 *   1 = some failures
 *   2 = fatal error
 *
 * Usage:
 *   node server/scripts/crypto-rotate.js                    # dry-run (default)
 *   node server/scripts/crypto-rotate.js --apply            # actually rotate
 *   node server/scripts/crypto-rotate.js --apply --limit 10 # rotate up to 10 rows
 *   node server/scripts/crypto-rotate.js --apply --table agents
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

// Load .env
const envPath = join(PROJECT_ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

// Parse CLI args
const args = process.argv.slice(2);
const applyMode = args.includes('--apply');
const dryRun = !applyMode;
const force = args.includes('--force');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const tableIdx = args.indexOf('--table');
const tableFilter = tableIdx >= 0 ? args[tableIdx + 1] : null;

if (tableFilter && !['agents', 'storage_connections'].includes(tableFilter)) {
  process.stdout.write(JSON.stringify({ error: `Unknown table: ${tableFilter}. Must be 'agents' or 'storage_connections'.` }) + '\n');
  process.exit(2);
}

// Suppress crypto module console output
const originalWarn = console.warn;
const originalError = console.error;
console.warn = () => {};
console.error = () => {};

const Database = (await import('better-sqlite3')).default;
const { encrypt, decrypt, _resetKeyringCache } = await import('../utils/crypto.js');

// Reset cache after env is loaded so crypto module picks up the .env values
_resetKeyringCache();

console.warn = originalWarn;
console.error = originalError;

try {
  const DB_PATH = process.env.DATABASE_PATH || join(PROJECT_ROOT, 'data/cavendo.db');
  if (!existsSync(DB_PATH)) {
    process.stdout.write(JSON.stringify({ error: 'Database not found', path: DB_PATH }) + '\n');
    process.exit(2);
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  // Determine current version using the same logic as the crypto runtime:
  // explicit env var, or highest version in keyring, or 1 for legacy single-key
  let currentVersion;
  if (process.env.ENCRYPTION_KEY_VERSION_CURRENT) {
    currentVersion = parseInt(process.env.ENCRYPTION_KEY_VERSION_CURRENT, 10);
  } else if (process.env.ENCRYPTION_KEYRING) {
    const versions = Object.keys(JSON.parse(process.env.ENCRYPTION_KEYRING)).map(Number).sort((a, b) => a - b);
    currentVersion = versions[versions.length - 1] || 1;
  } else {
    currentVersion = 1;
  }

  const result = {
    dryRun,
    currentVersion,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    details: []
  };

  let remaining = limit;

  // Rotate agents
  if ((!tableFilter || tableFilter === 'agents') && remaining > 0) {
    let agents;
    try {
      agents = db.prepare(`
        SELECT id, provider_api_key_encrypted, provider_api_key_iv, encryption_key_version
        FROM agents WHERE provider_api_key_encrypted IS NOT NULL
      `).all();
    } catch {
      agents = db.prepare(`
        SELECT id, provider_api_key_encrypted, provider_api_key_iv
        FROM agents WHERE provider_api_key_encrypted IS NOT NULL
      `).all();
    }

    for (const agent of agents) {
      if (remaining <= 0) break;
      const ver = agent.encryption_key_version ?? 1;

      // Skip if already on current version (unless --force)
      if (ver === currentVersion && !force) {
        result.skipped++;
        continue;
      }

      result.processed++;
      remaining--;

      try {
        const plaintext = decrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv, ver);
        if (!plaintext) {
          result.failed++;
          result.details.push({ table: 'agents', id: agent.id, column: 'provider_api_key', fromVersion: ver, error: 'decrypt_returned_null' });
          continue;
        }

        if (!dryRun) {
          const { encrypted, iv, keyVersion } = encrypt(plaintext);
          db.prepare(`
            UPDATE agents
            SET provider_api_key_encrypted = ?, provider_api_key_iv = ?, encryption_key_version = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(encrypted, iv, keyVersion, agent.id);
        }

        result.succeeded++;
        result.details.push({ table: 'agents', id: agent.id, column: 'provider_api_key', fromVersion: ver, toVersion: currentVersion, status: dryRun ? 'would_rotate' : 'rotated' });
      } catch (err) {
        result.failed++;
        result.details.push({ table: 'agents', id: agent.id, column: 'provider_api_key', fromVersion: ver, error: err.message });
      }
    }
  }

  // Rotate storage_connections (two encrypted columns each)
  if ((!tableFilter || tableFilter === 'storage_connections') && remaining > 0) {
    let conns;
    try {
      conns = db.prepare(`
        SELECT id, access_key_id_encrypted, access_key_id_iv, access_key_id_key_version,
          secret_access_key_encrypted, secret_access_key_iv, secret_access_key_key_version
        FROM storage_connections
        WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL
      `).all();
    } catch {
      conns = db.prepare(`
        SELECT id, access_key_id_encrypted, access_key_id_iv,
          secret_access_key_encrypted, secret_access_key_iv
        FROM storage_connections
        WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL
      `).all();
    }

    for (const conn of conns) {
      if (remaining <= 0) break;

      const akVer = conn.access_key_id_key_version ?? 1;
      const skVer = conn.secret_access_key_key_version ?? 1;

      // Skip if both already on current version (unless --force)
      if (akVer === currentVersion && skVer === currentVersion && !force) {
        result.skipped++;
        continue;
      }

      result.processed++;
      remaining--;

      try {
        const updates = [];
        const values = [];

        // Rotate access_key_id
        if (conn.access_key_id_encrypted && (akVer !== currentVersion || force)) {
          const plainAk = decrypt(conn.access_key_id_encrypted, conn.access_key_id_iv, akVer);
          if (!plainAk) {
            result.failed++;
            result.details.push({ table: 'storage_connections', id: conn.id, column: 'access_key_id', fromVersion: akVer, error: 'decrypt_returned_null' });
            continue;
          }
          if (!dryRun) {
            const enc = encrypt(plainAk);
            updates.push('access_key_id_encrypted = ?', 'access_key_id_iv = ?', 'access_key_id_key_version = ?');
            values.push(enc.encrypted, enc.iv, enc.keyVersion);
          }
        }

        // Rotate secret_access_key
        if (conn.secret_access_key_encrypted && (skVer !== currentVersion || force)) {
          const plainSk = decrypt(conn.secret_access_key_encrypted, conn.secret_access_key_iv, skVer);
          if (!plainSk) {
            result.failed++;
            result.details.push({ table: 'storage_connections', id: conn.id, column: 'secret_access_key', fromVersion: skVer, error: 'decrypt_returned_null' });
            continue;
          }
          if (!dryRun) {
            const enc = encrypt(plainSk);
            updates.push('secret_access_key_encrypted = ?', 'secret_access_key_iv = ?', 'secret_access_key_key_version = ?');
            values.push(enc.encrypted, enc.iv, enc.keyVersion);
          }
        }

        if (!dryRun && updates.length > 0) {
          updates.push("updated_at = datetime('now')");
          values.push(conn.id);
          db.prepare(`UPDATE storage_connections SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        }

        result.succeeded++;
        result.details.push({
          table: 'storage_connections',
          id: conn.id,
          columns: ['access_key_id', 'secret_access_key'],
          fromVersions: { access_key_id: akVer, secret_access_key: skVer },
          toVersion: currentVersion,
          status: dryRun ? 'would_rotate' : 'rotated'
        });
      } catch (err) {
        result.failed++;
        result.details.push({ table: 'storage_connections', id: conn.id, error: err.message });
      }
    }
  }

  db.close();

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.failed > 0 ? 1 : 0);
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err.message, stack: err.stack }) + '\n');
  process.exit(2);
}
