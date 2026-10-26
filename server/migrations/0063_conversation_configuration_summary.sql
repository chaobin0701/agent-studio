-- Up Migration
ALTER TABLE integration_calls ADD COLUMN configuration_summary JSONB;

-- Down Migration
ALTER TABLE integration_calls DROP COLUMN configuration_summary;
