-- Convert date columns from TEXT to TIMESTAMPTZ for proper temporal comparisons.
-- NULLIF(TRIM(...), '') guards against empty/blank strings in legacy rows.
ALTER TABLE tasks ALTER COLUMN due_date TYPE TIMESTAMPTZ USING NULLIF(TRIM(due_date), '')::TIMESTAMPTZ;
ALTER TABLE sprints ALTER COLUMN start_date TYPE TIMESTAMPTZ USING NULLIF(TRIM(start_date), '')::TIMESTAMPTZ;
ALTER TABLE sprints ALTER COLUMN end_date TYPE TIMESTAMPTZ USING NULLIF(TRIM(end_date), '')::TIMESTAMPTZ;
