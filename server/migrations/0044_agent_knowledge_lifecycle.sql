-- Up Migration
ALTER TABLE workspaces ADD COLUMN default_embedding_plan_version_id BIGINT REFERENCES model_plan_versions(id);
CREATE FUNCTION validate_workspace_embedding_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.default_embedding_plan_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM model_plan_versions v JOIN model_plans p ON p.id=v.plan_id
  JOIN embedding_profiles e ON e.model_plan_version_id=v.id
  WHERE v.id=NEW.default_embedding_plan_version_id AND v.workspace_id=NEW.id
    AND p.kind='embedding' AND v.status='published' AND e.enabled
 ) THEN RAISE EXCEPTION 'Default embedding must be a published plan in this workspace' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workspace_embedding_default BEFORE INSERT OR UPDATE OF default_embedding_plan_version_id ON workspaces
 FOR EACH ROW EXECUTE FUNCTION validate_workspace_embedding_default();

ALTER TABLE knowledge_bases ADD COLUMN index_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_bases ADD COLUMN auto_dirty BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE knowledge_bases ADD COLUMN index_error TEXT;
ALTER TABLE documents ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN index_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN index_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN processing_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_index_versions ADD COLUMN auto_activate BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE knowledge_index_versions ADD COLUMN expected_epoch INTEGER;
ALTER TABLE knowledge_index_versions ADD COLUMN base_version_id BIGINT;
ALTER TABLE knowledge_index_versions ADD CONSTRAINT index_base_version_fk FOREIGN KEY(knowledge_base_id,base_version_id)
 REFERENCES knowledge_index_versions(knowledge_base_id,id);
UPDATE knowledge_bases k SET auto_dirty=true WHERE k.archived_at IS NULL AND k.active_index_version_id IS NULL
 AND EXISTS(SELECT 1 FROM documents d JOIN document_blocks b ON b.document_id=d.id WHERE d.knowledge_base_id=k.id AND d.status='ready' AND d.archived_at IS NULL);

-- Existing immutable Agent versions and historical KB settings remain intact.
-- Agent versions without a retrieval field resolve to automatic / 5 / 12000.

-- Down Migration
ALTER TABLE knowledge_index_versions DROP CONSTRAINT index_base_version_fk;
ALTER TABLE knowledge_index_versions DROP COLUMN base_version_id, DROP COLUMN expected_epoch, DROP COLUMN auto_activate;
ALTER TABLE documents DROP COLUMN processing_epoch, DROP COLUMN index_pending, DROP COLUMN index_revision, DROP COLUMN deleted_at;
ALTER TABLE knowledge_bases DROP COLUMN index_error, DROP COLUMN auto_dirty, DROP COLUMN index_epoch;
DROP TRIGGER workspace_embedding_default ON workspaces;
DROP FUNCTION validate_workspace_embedding_default();
ALTER TABLE workspaces DROP COLUMN default_embedding_plan_version_id;
