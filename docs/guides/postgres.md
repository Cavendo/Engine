# PostgreSQL Setup Guide

Cavendo Engine supports both SQLite (default) and PostgreSQL as database backends. SQLite requires zero configuration; PostgreSQL is available for deployments that need concurrent access, replication, or integration with existing PostgreSQL infrastructure.

## Quick Start

### 1. Install the pg driver

```bash
npm install pg
```

> `pg` is listed as an optional dependency. SQLite-only installations don't need it.

### 2. Create a PostgreSQL database

```sql
CREATE DATABASE cavendo;
```

### 3. Configure environment

```bash
# .env
DB_DRIVER=postgres
DATABASE_URL=postgresql://user:password@localhost:5432/cavendo
```

### 4. Start the server

```bash
npm start
```

The server will automatically create all tables and run migrations on first boot.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_DRIVER` | `sqlite` | Database backend: `sqlite` or `postgres` |
| `DATABASE_URL` | — | PostgreSQL connection string (required when `DB_DRIVER=postgres`) |
| `DATABASE_PATH` | `./data/cavendo.db` | SQLite file path (used when `DB_DRIVER=sqlite`) |
| `PG_POOL_MIN` | `2` | Minimum connections in the pool |
| `PG_POOL_MAX` | `10` | Maximum connections in the pool |
| `PG_PARSE_TIMESTAMPS` | — | Set to `iso` to return timestamps as ISO strings instead of Date objects |

## Connection Pooling

The PostgreSQL adapter uses a connection pool (via `pg.Pool`). Default pool settings work well for most deployments. Adjust `PG_POOL_MIN` and `PG_POOL_MAX` based on your workload:

- **Low traffic** (dev/staging): `PG_POOL_MIN=1 PG_POOL_MAX=5`
- **Production**: `PG_POOL_MIN=2 PG_POOL_MAX=10` (default)
- **High concurrency**: `PG_POOL_MIN=5 PG_POOL_MAX=20`

## Timestamp Handling

By default, PostgreSQL returns `TIMESTAMPTZ` columns as JavaScript `Date` objects. If your application expects ISO string timestamps (matching SQLite behavior), set:

```bash
PG_PARSE_TIMESTAMPS=iso
```

This configures the pg driver to return raw ISO strings instead of Date objects.

## Differences from SQLite

The adapter layer handles most dialect differences transparently:

| Feature | SQLite | PostgreSQL | Handled by |
|---------|--------|------------|------------|
| Placeholders | `?` | `$1, $2, ...` | SQL rewriter (automatic) |
| Current time | `datetime('now')` | `NOW()` | SQL rewriter (automatic) |
| `INSERT OR IGNORE` | Native syntax | `ON CONFLICT DO NOTHING` | SQL rewriter (automatic) |
| Auto-increment IDs | `AUTOINCREMENT` | `SERIAL` | Separate schema file |
| Timestamps | `TEXT` | `TIMESTAMPTZ` | Separate schema file |
| `json_extract()` | SQLite function | `->>'key'` operator | Dialect check in code |
| `COLLATE NOCASE` | SQLite collation | `LOWER()` function | Dialect check in code |

## Schema Files

| File | Purpose |
|------|---------|
| `server/db/schema.sql` | SQLite schema (canonical baseline) |
| `server/db/schema.pg.sql` | PostgreSQL schema |
| `server/db/migrations/` | SQLite migrations |
| `server/db/migrations/pg/` | PostgreSQL migrations |

## Troubleshooting

### "DATABASE_URL is required when DB_DRIVER=postgres"

Set the `DATABASE_URL` environment variable to your PostgreSQL connection string.

### "Cannot find module 'pg'"

Install the pg driver: `npm install pg`

### Timestamps returned as Date objects

Set `PG_PARSE_TIMESTAMPS=iso` in your environment to get ISO string timestamps matching SQLite behavior.
