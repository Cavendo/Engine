/**
 * SQL Rewriter for PostgreSQL compatibility.
 *
 * Narrow scope — only handles four transformations:
 * 1. Placeholder rewriting: ? → $1, $2, ...
 * 2a. datetime('now', '[+-]N unit') → (NOW() [+-] INTERVAL 'N unit')
 * 2b. datetime('now') → NOW()
 * 3. INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
 *
 * Placeholder rewriting skips `?` inside:
 * - Single-quoted string literals ('...' with '' escape)
 * - Double-quoted identifiers ("..." with "" escape)
 * - Single-line comments (-- to end of line)
 * - Block comments (/* ... *​/)
 *
 * PostgreSQL JSON operators (?, ?|, ?&) are NOT supported through the
 * rewriter — they are indistinguishable from parameter placeholders.
 * If ?| or ?& are detected outside quotes/comments, a clear error is thrown.
 * For bare JSONB `?`, use jsonb_exists() or write raw $N placeholders.
 *
 * Everything else (json_extract, COLLATE NOCASE, PRAGMA) is handled
 * manually at the call site with db.dialect checks.
 */

/**
 * Rewrite SQLite-style SQL for PostgreSQL.
 * @param {string} sql - SQLite-compatible SQL string
 * @returns {string} PostgreSQL-compatible SQL string
 */
export function rewriteSQL(sql) {
  let result = sql;

  // 1. INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(result)) {
    result = result.replace(
      /\bINSERT\s+OR\s+IGNORE\b/gi,
      'INSERT'
    );
    // Append ON CONFLICT DO NOTHING before trailing semicolon or at end
    result = result.replace(/(\s*;?\s*)$/, ' ON CONFLICT DO NOTHING$1');
  }

  // 2a. datetime('now', '[+-]N unit') → (NOW() [+-] INTERVAL 'N unit')
  result = result.replace(
    /datetime\(\s*'now'\s*,\s*'([+-])(\d+\s+\w+)'\s*\)/gi,
    (_, sign, interval) => `(NOW() ${sign === '-' ? '-' : '+'} INTERVAL '${interval}')`
  );

  // 2b. datetime('now') → NOW()
  result = result.replace(/datetime\(\s*'now'\s*\)/gi, 'NOW()');

  // 3. Placeholder rewriting: ? → $1, $2, ...
  result = rewritePlaceholders(result);

  return result;
}

/**
 * Rewrite ? placeholders to $1, $2, ... (PostgreSQL positional params).
 *
 * Tracks 5 parser states to avoid rewriting `?` in non-SQL contexts:
 * - normal: active SQL — `?` gets rewritten
 * - single-quoted string ('...'): `?` preserved, '' is escape
 * - double-quoted identifier ("..."): `?` preserved, "" is escape
 * - line comment (-- to \n): `?` preserved
 * - block comment (/* to *​/): `?` preserved
 *
 * Detects PostgreSQL JSON operators (?| and ?&) outside quotes/comments
 * and throws a clear error, since they would be silently corrupted into
 * positional parameters.
 *
 * @param {string} sql
 * @returns {string}
 * @throws {Error} If PostgreSQL JSON operators (?| or ?&) are detected
 */
export function rewritePlaceholders(sql) {
  let counter = 0;
  let result = '';
  // States: 'normal', 'single_quote', 'double_quote', 'line_comment', 'block_comment'
  let state = 'normal';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : '';

    switch (state) {
      case 'normal':
        if (ch === "'" ) {
          state = 'single_quote';
          result += ch;
          i++;
        } else if (ch === '"') {
          state = 'double_quote';
          result += ch;
          i++;
        } else if (ch === '-' && next === '-') {
          state = 'line_comment';
          result += '--';
          i += 2;
        } else if (ch === '/' && next === '*') {
          state = 'block_comment';
          result += '/*';
          i += 2;
        } else if (ch === '?') {
          // Detect PG JSON operators ?| and ?&
          if (next === '|' || next === '&') {
            throw new Error(
              `SQL contains PostgreSQL JSON operator (?${next}). ` +
              'Use jsonb_exists() or parameterized $N placeholders instead.'
            );
          }
          counter++;
          result += `$${counter}`;
          i++;
        } else {
          result += ch;
          i++;
        }
        break;

      case 'single_quote':
        if (ch === "'" && next === "'") {
          // Escaped quote ''
          result += "''";
          i += 2;
        } else if (ch === "'") {
          // End of string literal
          state = 'normal';
          result += ch;
          i++;
        } else {
          result += ch;
          i++;
        }
        break;

      case 'double_quote':
        if (ch === '"' && next === '"') {
          // Escaped double-quote ""
          result += '""';
          i += 2;
        } else if (ch === '"') {
          // End of identifier
          state = 'normal';
          result += ch;
          i++;
        } else {
          result += ch;
          i++;
        }
        break;

      case 'line_comment':
        if (ch === '\n') {
          state = 'normal';
        }
        result += ch;
        i++;
        break;

      case 'block_comment':
        if (ch === '*' && next === '/') {
          state = 'normal';
          result += '*/';
          i += 2;
        } else {
          result += ch;
          i++;
        }
        break;
    }
  }

  return result;
}
