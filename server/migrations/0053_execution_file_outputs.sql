-- Up Migration
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'File retention requires a migration operator with BYPASSRLS or superuser'; END IF; END $$;
ALTER TABLE conversation_messages ADD COLUMN artifacts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(artifacts)='array');
CREATE TABLE execution_artifacts (
 id UUID PRIMARY KEY,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 trace_id UUID NOT NULL REFERENCES chat_traces(id) ON DELETE CASCADE,
 run_id UUID,
 source VARCHAR(20) NOT NULL CHECK(source IN ('generic_run','chat')),
 entry_version_id BIGINT NOT NULL REFERENCES agent_resource_versions(id),
 producer_version_id BIGINT NOT NULL REFERENCES agent_resource_versions(id),
 application_id UUID NOT NULL REFERENCES integration_apps(id),
 visitor_session_id UUID NOT NULL REFERENCES visitor_sessions(id),
 conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
 filename VARCHAR(80) NOT NULL CHECK(filename ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'),
 mime_type TEXT NOT NULL DEFAULT 'application/octet-stream' CHECK(mime_type='application/octet-stream'),
 byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 0 AND 131072),
 sha256 CHAR(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 content BYTEA,
 expires_at TIMESTAMPTZ NOT NULL,
 purged_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((content IS NOT NULL AND purged_at IS NULL AND octet_length(content)=byte_size) OR (content IS NULL AND purged_at IS NOT NULL)),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '8 days'),
 CHECK((source='generic_run' AND run_id IS NOT NULL AND conversation_id IS NULL) OR (source='chat' AND conversation_id IS NOT NULL))
);
CREATE INDEX execution_artifacts_trace_idx ON execution_artifacts(workspace_id,trace_id,created_at);
CREATE INDEX execution_artifacts_retention_idx ON execution_artifacts(expires_at) WHERE content IS NOT NULL;
CREATE TABLE execution_artifact_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 artifact_id UUID NOT NULL REFERENCES execution_artifacts(id) ON DELETE CASCADE,
 action VARCHAR(30) NOT NULL CHECK(action IN ('created','downloaded','purged','retention_purged','failed_purged')),
 actor_kind VARCHAR(20) NOT NULL CHECK(actor_kind IN ('visitor','admin','system')),
 actor_id VARCHAR(80) NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX execution_artifact_events_artifact_idx ON execution_artifact_events(workspace_id,artifact_id,created_at);
ALTER TABLE execution_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE execution_artifact_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_artifact_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON execution_artifacts USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled));
CREATE POLICY workspace_isolation ON execution_artifact_events USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled));
CREATE TRIGGER artifact_trace_workspace BEFORE INSERT OR UPDATE ON execution_artifacts FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('chat_traces','trace_id','id');
CREATE TRIGGER artifact_entry_workspace BEFORE INSERT OR UPDATE ON execution_artifacts FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_resource_versions','entry_version_id','id');
CREATE TRIGGER artifact_producer_workspace BEFORE INSERT OR UPDATE ON execution_artifacts FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_resource_versions','producer_version_id','id');
CREATE TRIGGER artifact_app_workspace BEFORE INSERT OR UPDATE ON execution_artifacts FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('integration_apps','application_id','id');
CREATE TRIGGER artifact_owner_workspace BEFORE INSERT OR UPDATE ON execution_artifacts FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('visitor_sessions','visitor_session_id','id');
CREATE TRIGGER artifact_conversation_workspace BEFORE INSERT OR UPDATE ON execution_artifacts FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('conversations','conversation_id','id');
CREATE TRIGGER artifact_event_workspace BEFORE INSERT OR UPDATE ON execution_artifact_events FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('execution_artifacts','artifact_id','id');

CREATE FUNCTION enforce_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.workspace_id,NEW.trace_id,NEW.run_id,NEW.source,NEW.entry_version_id,NEW.producer_version_id,NEW.application_id,NEW.visitor_session_id,NEW.conversation_id,NEW.filename,NEW.mime_type,NEW.byte_size,NEW.sha256,NEW.expires_at,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.trace_id,OLD.run_id,OLD.source,OLD.entry_version_id,OLD.producer_version_id,OLD.application_id,OLD.visitor_session_id,OLD.conversation_id,OLD.filename,OLD.mime_type,OLD.byte_size,OLD.sha256,OLD.expires_at,OLD.created_at)
     OR NEW.content IS NOT NULL OR NEW.purged_at IS NULL OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at) THEN
   RAISE EXCEPTION 'Execution artifact is immutable except irreversible content purge' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock(245131,(NEW.workspace_id%2147483647)::int);
 PERFORM 1 FROM chat_traces WHERE id=NEW.trace_id FOR UPDATE;
 IF (SELECT COALESCE(sum(byte_size),0) FROM execution_artifacts WHERE workspace_id=NEW.workspace_id AND content IS NOT NULL)+NEW.byte_size>134217728 THEN
  RAISE EXCEPTION 'Workspace artifact storage limit exceeded' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM execution_artifacts WHERE trace_id=NEW.trace_id)>=5 OR
    (SELECT COALESCE(sum(byte_size),0) FROM execution_artifacts WHERE trace_id=NEW.trace_id)+NEW.byte_size>524288 THEN
  RAISE EXCEPTION 'Execution artifact shared limit exceeded' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM agent_resource_versions e JOIN agent_resources r ON r.id=e.resource_id
   JOIN agent_resource_versions p ON p.id=NEW.producer_version_id JOIN agent_resources pr ON pr.id=p.resource_id
   JOIN chat_traces t ON t.id=NEW.trace_id
   WHERE e.id=NEW.entry_version_id AND e.workspace_id=NEW.workspace_id AND p.workspace_id=NEW.workspace_id AND t.workspace_id=NEW.workspace_id
   AND r.kind='agent' AND pr.kind='agent' AND e.status='published' AND p.status='published'
   AND e.config->'fileOutputs'->>'enabled'='true' AND p.config->'fileOutputs'->>'enabled'='true'
   AND (p.id=e.id OR e.config->'collaboration'->'memberVersionIds' @> jsonb_build_array(p.id))
   AND t.status='completed' AND (t.context_snapshot->'agentComposition'->>'entryVersionId')::bigint=e.id) THEN
  RAISE EXCEPTION 'Execution artifact requires authorised published producer and completed trace' USING ERRCODE='23503';
 END IF;
 IF NEW.source='generic_run' THEN
  IF NOT EXISTS(SELECT 1 FROM integration_calls c WHERE c.run_id=NEW.run_id AND c.trace_id=NEW.trace_id AND c.workspace_id=NEW.workspace_id
    AND c.app_id=NEW.application_id AND c.visitor_session_id=NEW.visitor_session_id AND c.conversation_id IS NULL AND c.status='running' AND c.expires_at>now()) THEN
   RAISE EXCEPTION 'Execution artifact owner does not match active Run' USING ERRCODE='23503';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM conversations c JOIN chat_traces t ON t.conversation_id=c.id AND t.id=NEW.trace_id
   WHERE c.id=NEW.conversation_id AND c.workspace_id=NEW.workspace_id AND c.application_id=NEW.application_id AND c.visitor_session_id=NEW.visitor_session_id
   AND (NEW.run_id IS NULL OR EXISTS(SELECT 1 FROM conversation_runs r WHERE r.id=NEW.run_id AND r.conversation_id=c.id AND r.status='running' AND r.expires_at>now()))) THEN
   RAISE EXCEPTION 'Execution artifact owner does not match active conversation' USING ERRCODE='23503';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_artifact_immutable BEFORE INSERT OR UPDATE ON execution_artifacts FOR EACH ROW EXECUTE FUNCTION enforce_execution_artifact();

-- Only expired or failed execution bytes may be purged across workspaces.
-- Fixed search_path, no dynamic targets, bounded batch, no returned tenant data.
-- Migration operator must have BYPASSRLS/superuser for this maintenance role.
DO $$ BEGIN EXECUTE format($ddl$
 CREATE FUNCTION purge_unavailable_execution_artifacts(batch_size integer DEFAULT 200) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO %I,pg_catalog SET row_security TO off AS $body$
 DECLARE affected integer;
 BEGIN
  WITH picked AS (SELECT a.id FROM execution_artifacts a JOIN chat_traces t ON t.id=a.trace_id WHERE a.content IS NOT NULL AND (a.expires_at<=now() OR t.status='failed') ORDER BY a.expires_at,a.id LIMIT GREATEST(1,LEAST(COALESCE(batch_size,200),200)) FOR UPDATE OF a SKIP LOCKED),
  purged AS (UPDATE execution_artifacts a SET content=NULL,purged_at=now() FROM picked p WHERE a.id=p.id RETURNING a.id,a.workspace_id),
  logged AS (INSERT INTO execution_artifact_events(workspace_id,artifact_id,action,actor_kind,actor_id) SELECT workspace_id,id,'retention_purged','system','retention' FROM purged)
  SELECT count(*)::integer INTO affected FROM purged;
  RETURN affected;
 END $body$;
$ddl$,current_schema()); END $$;
REVOKE ALL ON FUNCTION purge_unavailable_execution_artifacts(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_unavailable_execution_artifacts(integer) TO agent_studio_workspace_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON execution_artifacts,execution_artifact_events TO agent_studio_workspace_runtime;
GRANT USAGE,SELECT ON SEQUENCE execution_artifact_events_id_seq TO agent_studio_workspace_runtime;
INSERT INTO permissions(code,description) VALUES('executions.artifacts.manage','不可恢复地清理执行文件产物');
INSERT INTO role_permissions(role_id,permission_code) SELECT id,'executions.artifacts.manage' FROM roles WHERE code='super_admin';

-- Down Migration
DELETE FROM role_permissions WHERE permission_code='executions.artifacts.manage';
DELETE FROM permissions WHERE code='executions.artifacts.manage';
DROP FUNCTION purge_unavailable_execution_artifacts(integer);
DROP TABLE execution_artifact_events;
DROP TABLE execution_artifacts;
DROP FUNCTION enforce_execution_artifact();
ALTER TABLE conversation_messages DROP COLUMN artifacts;
