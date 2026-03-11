ALTER TABLE projects ADD COLUMN external_key VARCHAR(200) NULL;
CREATE UNIQUE INDEX idx_projects_external_key ON projects(external_key);
