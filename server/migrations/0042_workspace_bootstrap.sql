-- Up Migration
-- Fresh installations seed the internal Agent at application startup, after SQL migrations.
ALTER TABLE integration_apps ALTER COLUMN agent_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION enforce_agent_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='integration_apps' THEN
  IF NEW.agent_id IS NULL AND NEW.is_internal THEN RETURN NEW; END IF;
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
DROP POLICY workspace_isolation ON agent_environment_bindings;
CREATE POLICY workspace_isolation ON agent_environment_bindings
 USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled))
 WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled));

-- Down Migration
-- Existing internal applications may still be waiting for their startup seed.
DO $$ BEGIN RAISE EXCEPTION 'Bootstrap migration requires explicit Agent binding before downgrade'; END $$;
