PRAGMA foreign_keys = OFF;

CREATE TABLE users__tmp (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'reviewer' CHECK (role IN ('admin', 'operator', 'reviewer', 'viewer')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    force_password_change INTEGER DEFAULT 0 CHECK (force_password_change IN (0, 1)),
    last_login_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO users__tmp (
    id, email, password_hash, name, role, status, force_password_change, last_login_at, created_at, updated_at
)
SELECT
    id, email, password_hash, name, role, status, force_password_change, last_login_at, created_at, updated_at
FROM users;

DROP TABLE users;
ALTER TABLE users__tmp RENAME TO users;

PRAGMA foreign_keys = ON;
