/**
 * PostgreSQL Adapter — pg Pool-based adapter with SQL rewriting.
 *
 * API:
 *   await db.one(sql, params?)      → Row | undefined
 *   await db.many(sql, params?)     → Row[]
 *   await db.exec(sql, params?)     → { changes }
 *   await db.insert(sql, params?)   → { lastInsertRowid, changes }
 *   await db.tx(async (tx) => {})   → T
 *   await db.run(sql)               → void  (raw exec, no params — DDL)
 *   await db.close()                → Promise<void>
 *   db.dialect                      → 'postgres'
 *
 * Insert ID retrieval: db.insert() automatically appends RETURNING id
 * to the SQL if not already present. The returned lastInsertRowid is
 * the id column value from the first returned row.
 *
 * Transaction strategy: acquires a dedicated client from the pool,
 * BEGIN/COMMIT/ROLLBACK with genuine async. The tx object uses that
 * client for all queries. We enforce the same restriction as SQLite
 * for portability: only tx.* calls inside the callback.
 *
 * Transaction guard: AsyncLocalStorage tracks whether a tx() callback
 * is active. Calling db.one/many/exec/insert inside a tx() callback
 * triggers an error (default) or warning, controlled by TX_GUARD_MODE.
 * Nested db.tx() is explicitly disallowed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { rewriteSQL } from './sqlRewriter.js';

const txStore = new AsyncLocalStorage();
const txGuardMode = process.env.TX_GUARD_MODE || 'error';

/**
 * Guard against calling outer db.method() inside a tx() callback.
 * @param {string} method - Method name for the error message
 */
function guardOuterCall(method) {
  if (txStore.getStore()?.inTx) {
    const msg = `db.${method}() called during active transaction. Use tx.${method}() instead.`;
    if (txGuardMode === 'error') throw new Error(msg);
    console.warn(`[cavendo:tx-guard] ${msg}\n${new Error().stack}`);
  }
}

/**
 * Validate that SQL is a single-row INSERT statement.
 * @param {string} sql
 * @throws {Error} If SQL is not an INSERT or contains multi-row VALUES
 */
function assertSingleInsert(sql) {
  const trimmed = sql.trimStart();
  if (!/^INSERT\b/i.test(trimmed)) {
    throw new Error('db.insert() only accepts INSERT statements');
  }
  if (/\bVALUES\s*\(.*\)\s*,\s*\(/is.test(sql)) {
    throw new Error('db.insert() only supports single-row INSERT');
  }
}

/**
 * Create a PostgreSQL adapter wrapping a pg Pool.
 * @param {import('pg').Pool} pool - pg Pool instance
 * @returns {object} Adapter with one/many/exec/insert/tx/run/close/dialect
 */
export function createPgAdapter(pool) {
  const adapter = {
    dialect: 'postgres',

    /** @type {import('pg').Pool} */
    _pool: pool,

    /**
     * Fetch a single row.
     * @param {string} sql
     * @param {any[]} [params]
     * @returns {Promise<object|undefined>}
     */
    async one(sql, params) {
      guardOuterCall('one');
      const pgSql = rewriteSQL(sql);
      const result = await pool.query(pgSql, params || []);
      return result.rows[0] || undefined;
    },

    /**
     * Fetch multiple rows.
     * @param {string} sql
     * @param {any[]} [params]
     * @returns {Promise<object[]>}
     */
    async many(sql, params) {
      guardOuterCall('many');
      const pgSql = rewriteSQL(sql);
      const result = await pool.query(pgSql, params || []);
      return result.rows;
    },

    /**
     * Execute a statement (UPDATE/DELETE/INSERT when ID not needed).
     * @param {string} sql
     * @param {any[]} [params]
     * @returns {Promise<{changes: number}>}
     */
    async exec(sql, params) {
      guardOuterCall('exec');
      const pgSql = rewriteSQL(sql);
      const result = await pool.query(pgSql, params || []);
      return { changes: result.rowCount };
    },

    /**
     * Execute a single-row INSERT and return the auto-generated id.
     * Automatically appends `RETURNING id` if not already present.
     * Assumes the table primary key is named `id`.
     * Only single-row INSERT statements are accepted.
     * @param {string} sql - Must be an INSERT statement with a single VALUES row
     * @param {any[]} [params]
     * @returns {Promise<{lastInsertRowid: number, changes: number}>}
     * @throws {Error} If sql is not an INSERT or contains multi-row VALUES
     */
    async insert(sql, params) {
      guardOuterCall('insert');
      assertSingleInsert(sql);
      let pgSql = rewriteSQL(sql);
      pgSql = appendReturningId(pgSql);
      const result = await pool.query(pgSql, params || []);
      const id = result.rows[0]?.id ?? null;
      return {
        lastInsertRowid: id,
        changes: result.rowCount
      };
    },

    /**
     * Run a transaction. Acquires a dedicated client from the pool.
     * The callback receives a tx object with the same one/many/exec/insert API.
     *
     * Calling db.one/many/exec/insert inside the callback triggers a
     * guard error (or warning if TX_GUARD_MODE=warn). Nested db.tx()
     * is explicitly disallowed.
     *
     * @template T
     * @param {(tx: object) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async tx(fn) {
      if (txStore.getStore()?.inTx) {
        throw new Error('Nested transactions are not supported. Use the existing tx object.');
      }
      return txStore.run({ inTx: true }, async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx = createPgTxProxy(client);
          const result = await fn(tx);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      });
    },

    /**
     * Execute raw SQL without params (for DDL, multi-statement scripts).
     * @param {string} sql
     * @returns {Promise<void>}
     */
    async run(sql) {
      await pool.query(sql);
    },

    /**
     * Close the connection pool.
     * @returns {Promise<void>}
     */
    async close() {
      await pool.end();
    }
  };

  return adapter;
}

/**
 * Create a transaction proxy for a dedicated pg client.
 * @param {import('pg').PoolClient} client
 * @returns {object}
 */
function createPgTxProxy(client) {
  return {
    dialect: 'postgres',

    async one(sql, params) {
      const pgSql = rewriteSQL(sql);
      const result = await client.query(pgSql, params || []);
      return result.rows[0] || undefined;
    },

    async many(sql, params) {
      const pgSql = rewriteSQL(sql);
      const result = await client.query(pgSql, params || []);
      return result.rows;
    },

    async exec(sql, params) {
      const pgSql = rewriteSQL(sql);
      const result = await client.query(pgSql, params || []);
      return { changes: result.rowCount };
    },

    async insert(sql, params) {
      assertSingleInsert(sql);
      let pgSql = rewriteSQL(sql);
      pgSql = appendReturningId(pgSql);
      const result = await client.query(pgSql, params || []);
      const id = result.rows[0]?.id ?? null;
      return {
        lastInsertRowid: id,
        changes: result.rowCount
      };
    },

    async run(sql) {
      await client.query(sql);
    }
  };
}

/**
 * Append RETURNING id to an INSERT statement if not already present.
 * Assumes the table primary key is named `id` and the INSERT is single-row.
 * If the SQL already contains a RETURNING clause, it is left unchanged.
 * Handles trailing semicolons and whitespace.
 * @param {string} sql
 * @returns {string}
 */
function appendReturningId(sql) {
  if (/\bRETURNING\b/i.test(sql)) return sql;
  // Strip trailing semicolon/whitespace, append RETURNING id
  return sql.replace(/\s*;?\s*$/, ' RETURNING id');
}
