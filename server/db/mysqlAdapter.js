/**
 * MySQL Adapter — mysql2/promise pool-based adapter with SQL rewriting.
 *
 * API:
 *   await db.one(sql, params?)      → Row | undefined
 *   await db.many(sql, params?)     → Row[]
 *   await db.exec(sql, params?)     → { changes }
 *   await db.insert(sql, params?)   → { lastInsertRowid, changes }
 *   await db.tx(async (tx) => {})   → T
 *   await db.run(sql)               → void  (raw exec, no params — DDL)
 *   await db.close()                → Promise<void>
 *   db.dialect                      → 'mysql'
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { rewriteSQL } from './sqlRewriter.js';

const txStore = new AsyncLocalStorage();
const txGuardMode = process.env.TX_GUARD_MODE || 'error';
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function shouldUseTextProtocol(sql, params) {
  if (!params || params.length === 0) return false;
  return /\bLIMIT\s+\?(?:\s+OFFSET\s+\?)?(?:\s|$)/i.test(sql) || /\bOFFSET\s+\?(?:\s|$)/i.test(sql);
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function formatMysqlDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`
  ].join(' ');
}

function normalizeMysqlParamValue(value) {
  if (value instanceof Date) {
    return formatMysqlDateTime(value);
  }
  if (typeof value === 'string' && ISO_DATETIME_RE.test(value)) {
    return formatMysqlDateTime(value);
  }
  return value;
}

function normalizeMysqlParams(params) {
  return (params || []).map(normalizeMysqlParamValue);
}

async function runWithParams(executor, sql, params) {
  const normalizedParams = normalizeMysqlParams(params);
  if (shouldUseTextProtocol(sql, normalizedParams)) {
    return executor.query(sql, normalizedParams);
  }
  return executor.execute(sql, normalizedParams);
}

function guardOuterCall(method) {
  if (txStore.getStore()?.inTx) {
    const msg = `db.${method}() called during active transaction. Use tx.${method}() instead.`;
    if (txGuardMode === 'error') throw new Error(msg);
    console.warn(`[cavendo:tx-guard] ${msg}\n${new Error().stack}`);
  }
}

function assertSingleInsert(sql) {
  const trimmed = sql.trimStart();
  if (!/^INSERT\b/i.test(trimmed)) {
    throw new Error('db.insert() only accepts INSERT statements');
  }
  if (/\bVALUES\s*\(.*\)\s*,\s*\(/is.test(sql)) {
    throw new Error('db.insert() only supports single-row INSERT');
  }
}

export function createMysqlAdapter(pool) {
  return {
    dialect: 'mysql',
    _pool: pool,

    async one(sql, params) {
      guardOuterCall('one');
      const mysqlSql = rewriteSQL(sql, 'mysql');
      const [rows] = await runWithParams(pool, mysqlSql, params);
      return rows[0] || undefined;
    },

    async many(sql, params) {
      guardOuterCall('many');
      const mysqlSql = rewriteSQL(sql, 'mysql');
      const [rows] = await runWithParams(pool, mysqlSql, params);
      return rows;
    },

    async exec(sql, params) {
      guardOuterCall('exec');
      const mysqlSql = rewriteSQL(sql, 'mysql');
      const [result] = await runWithParams(pool, mysqlSql, params);
      return { changes: result.affectedRows || 0 };
    },

    async insert(sql, params) {
      guardOuterCall('insert');
      assertSingleInsert(sql);
      const mysqlSql = rewriteSQL(sql, 'mysql');
      const [result] = await runWithParams(pool, mysqlSql, params);
      return {
        lastInsertRowid: result.insertId ?? null,
        changes: result.affectedRows || 0
      };
    },

    async tx(fn) {
      if (txStore.getStore()?.inTx) {
        throw new Error('Nested transactions are not supported. Use the existing tx object.');
      }
      return txStore.run({ inTx: true }, async () => {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const tx = createMysqlTxProxy(conn);
          const result = await fn(tx);
          await conn.commit();
          return result;
        } catch (err) {
          await conn.rollback();
          throw err;
        } finally {
          conn.release();
        }
      });
    },

    async run(sql) {
      await pool.query(sql);
    },

    async close() {
      await pool.end();
    }
  };
}

function createMysqlTxProxy(conn) {
  return {
    dialect: 'mysql',

    async one(sql, params) {
      const mysqlSql = rewriteSQL(sql, 'mysql');
      const [rows] = await runWithParams(conn, mysqlSql, params);
      return rows[0] || undefined;
    },

    async many(sql, params) {
      const mysqlSql = rewriteSQL(sql, 'mysql');
      const [rows] = await runWithParams(conn, mysqlSql, params);
      return rows;
    },

    async exec(sql, params) {
      const mysqlSql = rewriteSQL(sql, 'mysql');
      const [result] = await runWithParams(conn, mysqlSql, params);
      return { changes: result.affectedRows || 0 };
    },

    async insert(sql, params) {
      assertSingleInsert(sql);
      const mysqlSql = rewriteSQL(sql, 'mysql');
      const [result] = await runWithParams(conn, mysqlSql, params);
      return {
        lastInsertRowid: result.insertId ?? null,
        changes: result.affectedRows || 0
      };
    },

    async run(sql) {
      await conn.query(sql);
    }
  };
}

export { shouldUseTextProtocol };
export { normalizeMysqlParamValue };
