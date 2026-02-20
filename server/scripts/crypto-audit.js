#!/usr/bin/env node
/**
 * Crypto Audit Script — read-only decryptability report.
 *
 * Reports which encrypted rows can/cannot be decrypted, grouped by table and key version.
 * Machine-readable JSON output to stdout.
 *
 * Exit codes:
 *   0 = all healthy
 *   1 = failures found
 *   2 = fatal error
 *
 * Usage:
 *   node server/scripts/crypto-audit.js
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

// Suppress console.warn/error from crypto module during audit (we capture results structurally)
const originalWarn = console.warn;
const originalError = console.error;
console.warn = () => {};
console.error = () => {};

const Database = (await import('better-sqlite3')).default;
const { canDecrypt, _resetKeyringCache } = await import('../utils/crypto.js');

// Reset cache after env is loaded so crypto module picks up the .env values
_resetKeyringCache();

// Restore console for our output
console.warn = originalWarn;
console.error = originalError;

try {
  const DB_PATH = process.env.DATABASE_PATH || join(PROJECT_ROOT, 'data/cavendo.db');
  if (!existsSync(DB_PATH)) {
    const result = { error: 'Database not found', path: DB_PATH };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(2);
  }

  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('foreign_keys = ON');

  const report = {
    timestamp: new Date().toISOString(),
    tables: {},
    summary: { total: 0, healthy: 0, failed: 0 }
  };

  // Check agents
  try {
    // Try with version column first
    let agents;
    let hasVersionCol = true;
    try {
      agents = db.prepare(`
        SELECT id, name, provider_api_key_encrypted, provider_api_key_iv, encryption_key_version
        FROM agents WHERE provider_api_key_encrypted IS NOT NULL
      `).all();
    } catch {
      hasVersionCol = false;
      agents = db.prepare(`
        SELECT id, name, provider_api_key_encrypted, provider_api_key_iv
        FROM agents WHERE provider_api_key_encrypted IS NOT NULL
      `).all();
    }

    const agentResults = [];
    for (const agent of agents) {
      const ver = hasVersionCol ? (agent.encryption_key_version ?? 1) : 1;
      const ok = canDecrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv, ver);
      report.summary.total++;
      if (ok) report.summary.healthy++;
      else report.summary.failed++;
      agentResults.push({
        id: agent.id,
        name: agent.name,
        column: 'provider_api_key',
        keyVersion: ver,
        decryptable: ok
      });
    }
    report.tables.agents = agentResults;
  } catch (err) {
    report.tables.agents = { error: err.message };
  }

  // Check storage_connections
  try {
    let conns;
    let hasVersionCols = true;
    try {
      conns = db.prepare(`
        SELECT id, name, access_key_id_encrypted, access_key_id_iv, access_key_id_key_version,
          secret_access_key_encrypted, secret_access_key_iv, secret_access_key_key_version
        FROM storage_connections
        WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL
      `).all();
    } catch {
      hasVersionCols = false;
      conns = db.prepare(`
        SELECT id, name, access_key_id_encrypted, access_key_id_iv,
          secret_access_key_encrypted, secret_access_key_iv
        FROM storage_connections
        WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL
      `).all();
    }

    const connResults = [];
    for (const conn of conns) {
      if (conn.access_key_id_encrypted) {
        const ver = hasVersionCols ? (conn.access_key_id_key_version ?? 1) : 1;
        const ok = canDecrypt(conn.access_key_id_encrypted, conn.access_key_id_iv, ver);
        report.summary.total++;
        if (ok) report.summary.healthy++;
        else report.summary.failed++;
        connResults.push({
          id: conn.id,
          name: conn.name,
          column: 'access_key_id',
          keyVersion: ver,
          decryptable: ok
        });
      }
      if (conn.secret_access_key_encrypted) {
        const ver = hasVersionCols ? (conn.secret_access_key_key_version ?? 1) : 1;
        const ok = canDecrypt(conn.secret_access_key_encrypted, conn.secret_access_key_iv, ver);
        report.summary.total++;
        if (ok) report.summary.healthy++;
        else report.summary.failed++;
        connResults.push({
          id: conn.id,
          name: conn.name,
          column: 'secret_access_key',
          keyVersion: ver,
          decryptable: ok
        });
      }
    }
    report.tables.storage_connections = connResults;
  } catch (err) {
    report.tables.storage_connections = { error: err.message };
  }

  db.close();

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.summary.failed > 0 ? 1 : 0);
} catch (err) {
  const result = { error: err.message, stack: err.stack };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(2);
}
