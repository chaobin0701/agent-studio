-- Up Migration
-- Copied provider accounts have no credential and remain disabled until configured.
ALTER TABLE model_accounts DROP CONSTRAINT model_accounts_check;
ALTER TABLE model_accounts ADD CONSTRAINT model_accounts_credential_check
 CHECK (NOT enabled OR api_key_ciphertext IS NOT NULL OR secret_ref IS NOT NULL);

CREATE FUNCTION validate_workspace_json_reference(target_table text, reference_id bigint, owner_workspace bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE valid boolean;
BEGIN
 IF reference_id IS NULL THEN RETURN; END IF;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE id=$1 AND workspace_id=$2)',target_table)
 INTO valid USING reference_id,owner_workspace;
 IF NOT valid THEN RAISE EXCEPTION 'Resource reference is outside workspace' USING ERRCODE='23503'; END IF;
END $$;
CREATE FUNCTION enforce_workspace_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value jsonb; resource_kind text; field text;
BEGIN
 IF TG_TABLE_NAME='agent_resource_versions' THEN
  SELECT kind INTO resource_kind FROM agent_resources WHERE id=NEW.resource_id;
  IF resource_kind='agent' THEN
   PERFORM validate_workspace_json_reference('prompt_versions',(NEW.config->>'promptVersionId')::bigint,NEW.workspace_id);
   PERFORM validate_workspace_json_reference('model_plan_versions',(NEW.config->>'modelPlanVersionId')::bigint,NEW.workspace_id);
   PERFORM validate_workspace_json_reference('model_plan_versions',(NEW.config->>'embeddingPlanVersionId')::bigint,NEW.workspace_id);
   FOREACH field IN ARRAY ARRAY['toolVersionIds','skillVersionIds'] LOOP
    FOR value IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.config->field,'[]')) LOOP
     PERFORM validate_workspace_json_reference('agent_resource_versions',value::bigint,NEW.workspace_id);
    END LOOP;
   END LOOP;
  END IF;
  FOREACH field IN ARRAY ARRAY['knowledgeBaseIds','allowedKnowledgeBaseIds'] LOOP
   FOR value IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.config->field,'[]')) LOOP
    PERFORM validate_workspace_json_reference('knowledge_bases',value::bigint,NEW.workspace_id);
   END LOOP;
  END LOOP;
 ELSIF TG_TABLE_NAME='model_plan_versions' THEN
  FOR value IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.config->'deployments','[]')) LOOP
   PERFORM validate_workspace_json_reference('model_accounts',(value->>'accountId')::bigint,NEW.workspace_id);
   PERFORM validate_workspace_json_reference('model_deployments',(value->>'id')::bigint,NEW.workspace_id);
  END LOOP;
 ELSIF TG_TABLE_NAME='knowledge_bases' THEN
  PERFORM validate_workspace_json_reference('embedding_profiles',(NEW.draft_config->>'embeddingProfileId')::bigint,NEW.workspace_id);
 ELSIF TG_TABLE_NAME='knowledge_index_versions' THEN
  PERFORM validate_workspace_json_reference('embedding_profiles',(NEW.config->>'embeddingProfileId')::bigint,NEW.workspace_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_configuration_workspace BEFORE INSERT OR UPDATE ON agent_resource_versions FOR EACH ROW EXECUTE FUNCTION enforce_workspace_configuration();
CREATE TRIGGER model_configuration_workspace BEFORE INSERT OR UPDATE ON model_plan_versions FOR EACH ROW EXECUTE FUNCTION enforce_workspace_configuration();
CREATE TRIGGER knowledge_configuration_workspace BEFORE INSERT OR UPDATE ON knowledge_bases FOR EACH ROW EXECUTE FUNCTION enforce_workspace_configuration();
CREATE TRIGGER index_configuration_workspace BEFORE INSERT OR UPDATE ON knowledge_index_versions FOR EACH ROW EXECUTE FUNCTION enforce_workspace_configuration();

CREATE FUNCTION enforce_agent_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='integration_apps' THEN
  IF NOT EXISTS(SELECT 1 FROM agent_resources WHERE id=NEW.agent_id AND kind='agent' AND workspace_id=NEW.workspace_id) THEN
   RAISE EXCEPTION 'Application requires an Agent in its workspace' USING ERRCODE='23503';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM agent_resource_versions v JOIN agent_resources r ON r.id=v.resource_id
    WHERE v.id=NEW.version_id AND r.id=NEW.agent_id AND r.kind='agent' AND v.status='published' AND r.workspace_id=NEW.workspace_id) THEN
   RAISE EXCEPTION 'Environment version must be published by this Agent' USING ERRCODE='23503';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_environment_owner BEFORE INSERT OR UPDATE ON agent_environment_bindings FOR EACH ROW EXECUTE FUNCTION enforce_agent_environment();
CREATE TRIGGER integration_agent_kind BEFORE INSERT OR UPDATE ON integration_apps FOR EACH ROW EXECUTE FUNCTION enforce_agent_environment();
DO $$ BEGIN
 EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO agent_studio_workspace_runtime',current_schema());
 EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE,SELECT ON SEQUENCES TO agent_studio_workspace_runtime',current_schema());
END $$;

-- Down Migration
DROP TRIGGER integration_agent_kind ON integration_apps;
DROP TRIGGER agent_environment_owner ON agent_environment_bindings;
DROP FUNCTION enforce_agent_environment;
DROP TRIGGER index_configuration_workspace ON knowledge_index_versions;
DROP TRIGGER knowledge_configuration_workspace ON knowledge_bases;
DROP TRIGGER model_configuration_workspace ON model_plan_versions;
DROP TRIGGER agent_configuration_workspace ON agent_resource_versions;
DROP FUNCTION enforce_workspace_configuration;
DROP FUNCTION validate_workspace_json_reference;
