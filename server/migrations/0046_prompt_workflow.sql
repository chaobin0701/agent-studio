-- Up Migration
ALTER TABLE prompt_versions
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN source_version_id BIGINT REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  ADD COLUMN published_by BIGINT REFERENCES admins(id) ON DELETE RESTRICT;
CREATE INDEX prompt_draft_source_idx ON prompt_versions(source_version_id);

-- Down Migration
DROP INDEX prompt_draft_source_idx;
ALTER TABLE prompt_versions DROP COLUMN published_by, DROP COLUMN source_version_id, DROP COLUMN revision;
