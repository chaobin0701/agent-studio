-- Up Migration
ALTER TABLE agent_resources ADD COLUMN archived_at TIMESTAMPTZ, ADD COLUMN deleted_at TIMESTAMPTZ,
 ADD CONSTRAINT agent_resource_removed_inactive CHECK(
  (archived_at IS NULL AND deleted_at IS NULL) OR (NOT enabled AND current_version_id IS NULL));
ALTER TABLE mcp_servers ADD COLUMN archived_at TIMESTAMPTZ, ADD COLUMN deleted_at TIMESTAMPTZ,
 ADD CONSTRAINT mcp_removed_inactive CHECK((archived_at IS NULL AND deleted_at IS NULL) OR NOT enabled);

-- Down Migration
ALTER TABLE mcp_servers DROP CONSTRAINT mcp_removed_inactive, DROP COLUMN archived_at, DROP COLUMN deleted_at;
ALTER TABLE agent_resources DROP CONSTRAINT agent_resource_removed_inactive, DROP COLUMN archived_at, DROP COLUMN deleted_at;
