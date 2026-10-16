-- Up Migration
CREATE TABLE agent_resources (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 kind VARCHAR(20) NOT NULL CHECK(kind IN ('agent','skill','tool','collaboration')),
 resource_key VARCHAR(80) NOT NULL, name VARCHAR(160) NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(kind,resource_key)
);
CREATE TABLE agent_resource_versions (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 resource_id BIGINT NOT NULL REFERENCES agent_resources(id), version INTEGER NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 config JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 tested_revision INTEGER, test_result JSONB, published_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(resource_id,version)
);
CREATE TABLE agent_application_bindings (
 environment VARCHAR(8) PRIMARY KEY CHECK(environment IN ('dev','test','prod')),
 mode VARCHAR(8) NOT NULL CHECK(mode IN ('single','multi')),
 version_id BIGINT NOT NULL REFERENCES agent_resource_versions(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION prevent_published_agent_resource_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='published' THEN RAISE EXCEPTION 'Published resource versions are immutable'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER agent_resource_immutable BEFORE UPDATE OR DELETE ON agent_resource_versions FOR EACH ROW EXECUTE FUNCTION prevent_published_agent_resource_change();
CREATE INDEX agent_resource_versions_lookup ON agent_resource_versions(resource_id,version DESC);
ALTER TABLE conversations ADD COLUMN agent_memory_scope VARCHAR(64), ADD COLUMN agent_memory_boundary_id BIGINT NOT NULL DEFAULT 0;
-- Existing Agent permissions authorize the resource workspace; tool execution testing is a separate privilege.
INSERT INTO permissions(code,description) VALUES('agent_tools.execute','测试执行 Agent 工具（调用真实端点）') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_code) SELECT id,'agent_tools.execute' FROM roles WHERE code='super_admin' ON CONFLICT DO NOTHING;

-- Down Migration
ALTER TABLE conversations DROP COLUMN agent_memory_scope, DROP COLUMN agent_memory_boundary_id;
DROP TABLE agent_application_bindings;
DROP TABLE agent_resource_versions;
DROP FUNCTION prevent_published_agent_resource_change();
DROP TABLE agent_resources;
DELETE FROM role_permissions WHERE permission_code='agent_tools.execute';
DELETE FROM permissions WHERE code='agent_tools.execute';
