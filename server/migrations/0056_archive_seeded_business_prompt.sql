-- Up Migration
-- Historical prompt versions remain readable, but retired resources cannot
-- silently become the default choice for a newly created Agent.
SET LOCAL row_security = off;
ALTER TABLE prompt_resources ADD COLUMN archived_at TIMESTAMPTZ;
UPDATE prompt_resources SET archived_at=now() WHERE prompt_key='agent.default_support.business';
CREATE TEMP TABLE affected_prompt_agents ON COMMIT DROP AS
 WITH RECURSIVE affected(id) AS (
  SELECT r.id FROM agent_resources r JOIN agent_resource_versions v ON v.id=r.current_version_id
   JOIN prompt_versions p ON p.id=(v.config->>'promptVersionId')::bigint
   JOIN prompt_resources pr ON pr.id=p.resource_id WHERE pr.archived_at IS NOT NULL
  UNION
  SELECT r.id FROM agent_resources r JOIN agent_resource_versions v ON v.id=r.current_version_id
   JOIN affected a ON EXISTS(SELECT 1 FROM agent_resource_versions av WHERE av.resource_id=a.id
    AND COALESCE(v.config->'collaboration'->'memberVersionIds','[]'::jsonb) @> jsonb_build_array(av.id))
 ) SELECT id FROM affected;
UPDATE integration_apps SET enabled=false,auth_version=auth_version+1,updated_at=now()
 WHERE agent_id IN(SELECT id FROM affected_prompt_agents);
UPDATE agent_resources SET enabled=false,current_version_id=NULL WHERE id IN(SELECT id FROM affected_prompt_agents);
DELETE FROM prompt_environment_bindings WHERE resource_id IN(SELECT id FROM prompt_resources WHERE archived_at IS NOT NULL);
INSERT INTO audit_logs(workspace_id,actor_admin_id,action,target_type,target_id,details)
 SELECT workspace_id,(SELECT min(id) FROM admins),'prompt.archived','prompt',id::text,
 jsonb_build_object('source','system_migration','historyPreserved',true) FROM prompt_resources
 WHERE archived_at IS NOT NULL AND EXISTS(SELECT 1 FROM admins);

-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Retired business prompts require explicit operator recovery, not automatic reactivation'; END $$;
