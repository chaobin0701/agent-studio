-- Up Migration
ALTER TABLE agent_resources ADD COLUMN current_version_id BIGINT REFERENCES agent_resource_versions(id);

-- Preserve production first, then test/dev, then the latest published version.
-- Never rewrite immutable version contents or remove legacy environment records.
UPDATE agent_resources r SET current_version_id=COALESCE(
 (SELECT b.version_id FROM agent_environment_bindings b
  JOIN agent_resource_versions v ON v.id=b.version_id
  WHERE b.agent_id=r.id AND b.workspace_id=r.workspace_id AND v.resource_id=r.id AND v.status='published'
  ORDER BY CASE b.environment WHEN 'prod' THEN 0 WHEN 'test' THEN 1 ELSE 2 END LIMIT 1),
 (SELECT v.id FROM agent_resource_versions v WHERE v.resource_id=r.id AND v.status='published' ORDER BY v.version DESC LIMIT 1)
) WHERE r.kind='agent';

CREATE FUNCTION enforce_agent_current_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.current_version_id IS NOT NULL AND (NEW.kind<>'agent' OR NOT EXISTS(
  SELECT 1 FROM agent_resource_versions v WHERE v.id=NEW.current_version_id
   AND v.resource_id=NEW.id AND v.workspace_id=NEW.workspace_id AND v.status='published'
 )) THEN
  RAISE EXCEPTION 'Current Agent version must be published by this Agent in its workspace' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_current_version_owner BEFORE INSERT OR UPDATE ON agent_resources
 FOR EACH ROW EXECUTE FUNCTION enforce_agent_current_version();

-- Down Migration
DROP TRIGGER agent_current_version_owner ON agent_resources;
DROP FUNCTION enforce_agent_current_version;
ALTER TABLE agent_resources DROP COLUMN current_version_id;
