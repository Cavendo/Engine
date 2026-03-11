ALTER TABLE projects ADD COLUMN external_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_external_key ON projects(external_key) WHERE external_key IS NOT NULL;
