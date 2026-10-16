-- Up Migration
CREATE TABLE agent_environment_bindings (
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 agent_id BIGINT NOT NULL REFERENCES agent_resources(id),
 environment VARCHAR(8) NOT NULL CHECK(environment IN ('dev','test','prod')),
 version_id BIGINT NOT NULL REFERENCES agent_resource_versions(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,agent_id,environment)
);
INSERT INTO agent_environment_bindings(workspace_id,agent_id,environment,version_id)
 SELECT b.workspace_id,v.resource_id,b.environment,v.id FROM agent_application_bindings b
 JOIN agent_resource_versions v ON v.id=b.version_id JOIN agent_resources r ON r.id=v.resource_id WHERE r.kind='agent';
ALTER TABLE integration_apps ADD COLUMN agent_id BIGINT REFERENCES agent_resources(id),
 ADD COLUMN environment VARCHAR(8) NOT NULL DEFAULT 'prod' CHECK(environment IN ('dev','test','prod'));
UPDATE integration_apps a SET agent_id=(SELECT b.agent_id FROM agent_environment_bindings b WHERE b.workspace_id=a.workspace_id AND b.environment='prod' ORDER BY b.agent_id LIMIT 1);
CREATE TRIGGER workspace_app_agent BEFORE INSERT OR UPDATE ON integration_apps
 FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_resources','agent_id','id');
CREATE TRIGGER workspace_binding_agent BEFORE INSERT OR UPDATE ON agent_environment_bindings
 FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_resources','agent_id','id');
CREATE TRIGGER workspace_binding_version BEFORE INSERT OR UPDATE ON agent_environment_bindings
 FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_resource_versions','version_id','id');
ALTER TABLE agent_environment_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_environment_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON agent_environment_bindings USING(workspace_id=current_workspace_id()) WITH CHECK(workspace_id=current_workspace_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON agent_environment_bindings TO agent_studio_workspace_runtime;

-- Down Migration
ALTER TABLE integration_apps DROP COLUMN agent_id,DROP COLUMN environment;
DROP TABLE agent_environment_bindings;
