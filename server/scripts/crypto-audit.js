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

// Load .env via centralized bootstrap (must come before adapter/crypto imports)
import '../env.js';

// Suppress console.warn/error from crypto module during audit (we capture results structurally)
const originalWarn = console.warn;
const originalError = console.error;
console.warn = () => {};
console.error = () => {};

const { default: db } = await import('../db/adapter.js');
const { canDecrypt, _resetKeyringCache } = await import('../utils/crypto.js');

// Reset cache after env is loaded so crypto module picks up the .env values
_resetKeyringCache();

// Restore console for our output
console.warn = originalWarn;
console.error = originalError;

try {
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
      agents = await db.many(`
        SELECT id, name, provider_api_key_encrypted, provider_api_key_iv, encryption_key_version
        FROM agents WHERE provider_api_key_encrypted IS NOT NULL
      `);
    } catch {
      hasVersionCol = false;
      agents = await db.many(`
        SELECT id, name, provider_api_key_encrypted, provider_api_key_iv
        FROM agents WHERE provider_api_key_encrypted IS NOT NULL
      `);
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
      conns = await db.many(`
        SELECT id, name, access_key_id_encrypted, access_key_id_iv, access_key_id_key_version,
          secret_access_key_encrypted, secret_access_key_iv, secret_access_key_key_version
        FROM storage_connections
        WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL
      `);
    } catch {
      hasVersionCols = false;
      conns = await db.many(`
        SELECT id, name, access_key_id_encrypted, access_key_id_iv,
          secret_access_key_encrypted, secret_access_key_iv
        FROM storage_connections
        WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL
      `);
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

  await db.close();

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.summary.failed > 0 ? 1 : 0);
} catch (err) {
  const result = { error: err.message, stack: err.stack };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(2);
}
