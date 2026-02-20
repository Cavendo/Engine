import { readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from '../utils/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Initialize database schema and seed data.
 * Accepts the shared db singleton — does NOT open/close its own connection.
 * @param {import('better-sqlite3').Database} db
 */
export async function initializeDatabase(db) {
  const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/cavendo.db');

  // Ensure the data directory exists
  mkdirSync(dirname(DB_PATH), { recursive: true });

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Read and execute schema
  // Note: schema.sql is the canonical baseline schema.
  // For upgrades, use the migrator (server/db/migrator.js) which runs before this.
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  console.log('Database initialized at:', DB_PATH);

  // Backfill users.force_password_change for existing databases
  const userColumns = db.prepare(`PRAGMA table_info(users)`).all();
  const hasForcePasswordChange = userColumns.some(c => c.name === 'force_password_change');
  if (!hasForcePasswordChange) {
    db.exec(`
      ALTER TABLE users
      ADD COLUMN force_password_change INTEGER DEFAULT 0 CHECK (force_password_change IN (0, 1))
    `);
  }

  // Create default admin user if none exists
  const existingAdmin = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!existingAdmin) {
    // Use bcrypt for password hashing
    const passwordHash = await hashPassword('admin');
    db.prepare(`
      INSERT INTO users (email, password_hash, name, role, force_password_change)
      VALUES (?, ?, ?, ?, 1)
    `).run('admin@cavendo.local', passwordHash, 'Admin', 'admin');
    console.log('Default admin user created: admin@cavendo.local / admin');
    console.log('!! CHANGE THIS PASSWORD IMMEDIATELY IN PRODUCTION !!');
  }

  // Existing seeded admin should be forced to change password on first login
  db.prepare(`
    UPDATE users
    SET force_password_change = 1
    WHERE email = 'admin@cavendo.local'
      AND role = 'admin'
      AND COALESCE(last_login_at, '') = ''
      AND force_password_change = 0
  `).run();

  // Ensure all users have a linked human agent (backfill for existing users)
  const usersWithoutAgent = db.prepare(`
    SELECT u.id, u.name, u.email FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM agents a WHERE a.owner_user_id = u.id AND a.execution_mode = 'human'
    )
  `).all();

  for (const user of usersWithoutAgent) {
    db.prepare(`
      INSERT INTO agents (name, type, description, capabilities, execution_mode, owner_user_id, status)
      VALUES (?, 'supervised', ?, '[]', 'human', ?, 'active')
    `).run(
      user.name || user.email.split('@')[0],
      `Linked agent for user ${user.name || user.email}`,
      user.id
    );
    console.log(`Created linked agent for user: ${user.name || user.email}`);
  }

  // Create default project if none exists
  const existingProject = db.prepare('SELECT id FROM projects LIMIT 1').get();
  if (!existingProject) {
    db.prepare(`
      INSERT INTO projects (name, description, status)
      VALUES (?, ?, ?)
    `).run(
      'My First Project',
      'Default project created during setup. Rename it or create additional projects to organize your work.',
      'active'
    );
    console.log('Default project created: "My First Project"');
  }

  return true;
}

// Run if called directly (standalone bootstrap)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // When run standalone, create our own db connection
  const Database = (await import('better-sqlite3')).default;
  const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/cavendo.db');
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  initializeDatabase(db).then(() => {
    db.close();
  }).catch(err => {
    console.error('Failed to initialize database:', err);
    db.close();
    process.exit(1);
  });
}
