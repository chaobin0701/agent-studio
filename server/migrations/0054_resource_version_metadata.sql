-- Up Migration
-- Resource names are versioned metadata, not additions to execution configuration.
-- Initialize the new metadata under the migration's table lock; existing config,
-- revisions, publication records and test signatures are unchanged.
ALTER TABLE agent_resources ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE agent_resources SET updated_at=created_at;
ALTER TABLE agent_resource_versions ADD COLUMN display_name VARCHAR(160), ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE agent_resource_versions DISABLE TRIGGER agent_resource_immutable;
UPDATE agent_resource_versions v SET display_name=r.name,updated_at=GREATEST(v.created_at,COALESCE(v.published_at,v.created_at)) FROM agent_resources r WHERE r.id=v.resource_id;
ALTER TABLE agent_resource_versions ENABLE TRIGGER agent_resource_immutable;
ALTER TABLE agent_resource_versions ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE agent_resource_versions ADD CONSTRAINT version_display_name_nonempty CHECK(length(btrim(display_name))>0);

CREATE FUNCTION maintain_resource_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='agent_resources' THEN
  IF TG_OP='UPDATE' THEN NEW.updated_at=now(); END IF;
 ELSE
  IF TG_OP='INSERT' AND NEW.display_name IS NULL THEN
   SELECT r.name INTO NEW.display_name FROM agent_resources r WHERE r.id=NEW.resource_id AND r.workspace_id=NEW.workspace_id;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.config IS DISTINCT FROM OLD.config OR NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.status IS DISTINCT FROM OLD.status) THEN
   NEW.updated_at=now();
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_resource_metadata BEFORE UPDATE ON agent_resources FOR EACH ROW EXECUTE FUNCTION maintain_resource_metadata();
-- Workspace trigger runs before metadata; immutable trigger still rejects every
-- attempted update of an already published version, including its name.
CREATE TRIGGER resource_version_metadata BEFORE INSERT OR UPDATE ON agent_resource_versions FOR EACH ROW EXECUTE FUNCTION maintain_resource_metadata();

-- Down Migration
DROP TRIGGER resource_version_metadata ON agent_resource_versions;
DROP TRIGGER agent_resource_metadata ON agent_resources;
DROP FUNCTION maintain_resource_metadata();
ALTER TABLE agent_resource_versions DROP CONSTRAINT version_display_name_nonempty, DROP COLUMN display_name, DROP COLUMN updated_at;
ALTER TABLE agent_resources DROP COLUMN updated_at;
