import { readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from '../utils/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripLeadingSqlComments(sql) {
  return sql.replace(/^(?:\s*--.*\n)+/g, '').trim();
}

export function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let prev = '';

  for (const char of sql) {
    if (char === "'" && !inDouble && !inBacktick && prev !== '\\') {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle && !inBacktick && prev !== '\\') {
      inDouble = !inDouble;
    } else if (char === '`' && !inSingle && !inDouble && prev !== '\\') {
      inBacktick = !inBacktick;
    }

    if (char === ';' && !inSingle && !inDouble && !inBacktick) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      prev = '';
      continue;
    }

    current += char;
    prev = char;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);

  return statements;
}

async function mysqlIndexExists(db, tableName, indexName) {
  const row = await db.one(`
    SELECT INDEX_NAME
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = ?
      AND index_name = ?
    LIMIT 1
  `, [tableName, indexName]);

  return Boolean(row);
}

export async function coreTableExists(db, tableName) {
  if (db.dialect === 'sqlite') {
    const row = await db.one(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName]
    );
    return Boolean(row);
  }

  if (db.dialect === 'postgres') {
    const row = await db.one(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ?
      LIMIT 1
    `, [tableName]);
    return Boolean(row);
  }

  const row = await db.one(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = ?
    LIMIT 1
  `, [tableName]);
  return Boolean(row);
}

export async function applyMySqlSchema(db, schema) {
  const statements = splitSqlStatements(schema);

  for (const statement of statements) {
    const normalized = stripLeadingSqlComments(statement);
    if (!normalized) continue;

    const indexMatch = normalized.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+`?([a-zA-Z0-9_]+)`?\s+ON\s+`?([a-zA-Z0-9_]+)`?/i);
    if (indexMatch) {
      const [, indexName, tableName] = indexMatch;
      if (await mysqlIndexExists(db, tableName, indexName)) {
        continue;
      }
    }

    await db.run(statement);
  }
}

/**
 * Initialize database schema and seed data.
 * Accepts the shared db adapter — does NOT open/close its own connection.
 * @param {object} db - Database adapter (one/many/exec/insert/run/dialect)
 */
export async function initializeDatabase(db) {
  const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/cavendo.db');

  if (db.dialect === 'sqlite') {
    // Ensure the data directory exists
    mkdirSync(dirname(DB_PATH), { recursive: true });

    // Enable foreign keys (SQLite-only, PG has this built-in)
    await db.run('PRAGMA foreign_keys = ON');
  }

  const hasUsersTable = await coreTableExists(db, 'users');

  // Read and execute baseline schema only for fresh databases.
  // Existing databases must evolve through migrations, not by replaying the
  // latest schema file against older tables.
  if (!hasUsersTable) {
    const schemaFile = db.dialect === 'postgres'
      ? 'schema.pg.sql'
      : (db.dialect === 'mysql' ? 'schema.mysql.sql' : 'schema.sql');
    const schema = readFileSync(join(__dirname, schemaFile), 'utf-8');
    if (db.dialect === 'mysql') {
      await applyMySqlSchema(db, schema);
    } else {
      await db.run(schema);
    }
  }

  console.log('Database initialized at:',
    (db.dialect === 'postgres' || db.dialect === 'mysql')
      ? process.env.DATABASE_URL?.replace(/\/\/[^@]+@/, '//***@')
      : DB_PATH
  );

  // Backfill users.force_password_change for existing databases
  if (db.dialect === 'sqlite') {
    const userColumns = await db.many(`PRAGMA table_info(users)`);
    const hasForcePasswordChange = userColumns.some(c => c.name === 'force_password_change');
    if (!hasForcePasswordChange) {
      await db.run(`
        ALTER TABLE users
        ADD COLUMN force_password_change INTEGER DEFAULT 0 CHECK (force_password_change IN (0, 1))
      `);
    }
  } else if (db.dialect === 'postgres') {
    // PostgreSQL: check information_schema
    const col = await db.one(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'force_password_change'
    `);
    if (!col) {
      await db.run(`
        ALTER TABLE users
        ADD COLUMN force_password_change INTEGER DEFAULT 0 CHECK (force_password_change IN (0, 1))
      `);
    }
  } else if (db.dialect === 'mysql') {
    const col = await db.one(`
      SELECT COLUMN_NAME AS column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'force_password_change'
    `);
    if (!col) {
      await db.run(`
        ALTER TABLE users
        ADD COLUMN force_password_change INTEGER DEFAULT 0 CHECK (force_password_change IN (0, 1))
      `);
    }
  }

  // Create default admin user if none exists
  const existingAdmin = await db.one('SELECT id FROM users WHERE role = ?', ['admin']);
  if (!existingAdmin) {
    // Use bcrypt for password hashing
    const passwordHash = await hashPassword('admin');
    await db.exec(`
      INSERT INTO users (email, password_hash, name, role, force_password_change)
      VALUES (?, ?, ?, ?, 1)
    `, ['admin@cavendo.local', passwordHash, 'Admin', 'admin']);
    console.log('Default admin user created: admin@cavendo.local / admin');
    console.log('!! CHANGE THIS PASSWORD IMMEDIATELY IN PRODUCTION !!');
  }

  // Existing seeded admin should be forced to change password on first login
  await db.exec(`
    UPDATE users
    SET force_password_change = 1
    WHERE email = 'admin@cavendo.local'
      AND role = 'admin'
      AND COALESCE(last_login_at, '') = ''
      AND force_password_change = 0
  `);

  // Ensure all users have a linked human agent (backfill for existing users)
  const usersWithoutAgent = await db.many(`
    SELECT u.id, u.name, u.email FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM agents a WHERE a.owner_user_id = u.id AND a.execution_mode = 'human'
    )
  `);

  for (const user of usersWithoutAgent) {
    await db.exec(`
      INSERT INTO agents (name, type, description, capabilities, execution_mode, owner_user_id, status)
      VALUES (?, 'supervised', ?, '[]', 'human', ?, 'active')
    `, [
      user.name || user.email.split('@')[0],
      `Linked agent for user ${user.name || user.email}`,
      user.id
    ]);
    console.log(`Created linked agent for user: ${user.name || user.email}`);
  }

  // Create default project if none exists
  const existingProject = await db.one('SELECT id FROM projects LIMIT 1');
  if (!existingProject) {
    await db.exec(`
      INSERT INTO projects (name, description, status)
      VALUES (?, ?, ?)
    `, [
      'My First Project',
      'Default project created during setup. Rename it or create additional projects to organize your work.',
      'active'
    ]);
    console.log('Default project created: "My First Project"');
  }

  return true;
}

// Run if called directly (standalone bootstrap)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { createSqliteAdapter } = await import('./sqliteAdapter.js');
  const Database = (await import('better-sqlite3')).default;
  const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/cavendo.db');
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const raw = new Database(DB_PATH);
  raw.pragma('journal_mode = WAL');
  const db = createSqliteAdapter(raw);
  initializeDatabase(db).then(() => {
    db.close();
  }).catch(err => {
    console.error('Failed to initialize database:', err);
    db.close();
    process.exit(1);
  });
}
