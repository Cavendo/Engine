-- Convert date columns from TEXT to TIMESTAMPTZ for proper temporal comparisons.
-- Cast through text so this stays safe if a fresh PG schema already uses TIMESTAMPTZ.
-- NULLIF(BTRIM(...), '') guards against empty/blank strings in legacy rows.
ALTER TABLE tasks ALTER COLUMN due_date TYPE TIMESTAMPTZ USING NULLIF(BTRIM(due_date::text), '')::TIMESTAMPTZ;
ALTER TABLE sprints ALTER COLUMN start_date TYPE TIMESTAMPTZ USING NULLIF(BTRIM(start_date::text), '')::TIMESTAMPTZ;
ALTER TABLE sprints ALTER COLUMN end_date TYPE TIMESTAMPTZ USING NULLIF(BTRIM(end_date::text), '')::TIMESTAMPTZ;
