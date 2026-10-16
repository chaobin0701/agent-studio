-- Up Migration
CREATE TABLE tool_credentials (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 name VARCHAR(120) NOT NULL, kind VARCHAR(20) NOT NULL CHECK(kind IN ('bearer','api_key')),
 header VARCHAR(80) NOT NULL, encrypted_secret TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT true, revision INTEGER NOT NULL DEFAULT 1,
 created_by BIGINT REFERENCES admins(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE mcp_servers (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 server_key VARCHAR(80) NOT NULL, name VARCHAR(120) NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,server_key)
);
CREATE TABLE mcp_server_versions (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 server_id BIGINT NOT NULL REFERENCES mcp_servers(id), version INTEGER NOT NULL,
 config JSONB NOT NULL, catalog JSONB NOT NULL DEFAULT '[]',
 created_by BIGINT REFERENCES admins(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(server_id,version)
);
CREATE TRIGGER mcp_server_workspace_fk BEFORE INSERT OR UPDATE ON mcp_server_versions
 FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('mcp_servers','server_id','id');
CREATE FUNCTION immutable_mcp_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MCP connection and tool contracts are immutable'; END $$;
CREATE TRIGGER immutable_mcp_contract BEFORE UPDATE OR DELETE ON mcp_server_versions
 FOR EACH ROW EXECUTE FUNCTION immutable_mcp_contract();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['tool_credentials','mcp_servers','mcp_server_versions'] LOOP
  EXECUTE format('CREATE INDEX %I ON %I(workspace_id)',t||'_workspace_idx',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workspace_isolation ON %I USING (workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO agent_studio_workspace_runtime',t);
 END LOOP;
 EXECUTE format('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA %I TO agent_studio_workspace_runtime',current_schema());
END $$;
-- Credentials remain mutable for rotation/revocation; configuration never contains plaintext secrets.
-- Down Migration
DROP TABLE mcp_server_versions;
DROP FUNCTION immutable_mcp_contract();
DROP TABLE mcp_servers;
DROP TABLE tool_credentials;
