-- Up Migration
-- A real administrator principal shares the existing execution/model ledger.
-- Never fabricate a visitor session, application, API key or caller credential.
ALTER TABLE integration_calls ALTER COLUMN app_id DROP NOT NULL,ALTER COLUMN visitor_session_id DROP NOT NULL;
ALTER TABLE integration_calls ADD COLUMN admin_actor_id BIGINT REFERENCES admins(id),ADD COLUMN entry_agent_id BIGINT REFERENCES agent_resources(id);
ALTER TABLE integration_calls ADD CONSTRAINT execution_principal_valid CHECK(
 (app_id IS NOT NULL AND visitor_session_id IS NOT NULL AND admin_actor_id IS NULL) OR
 (app_id IS NULL AND visitor_session_id IS NULL AND key_id IS NULL AND admin_actor_id IS NOT NULL AND entry_agent_id IS NOT NULL AND conversation_id IS NULL));
CREATE UNIQUE INDEX administrator_call_idempotency ON integration_calls(workspace_id,admin_actor_id,entry_agent_id,idempotency_key) WHERE admin_actor_id IS NOT NULL;
CREATE INDEX administrator_call_usage ON integration_calls(workspace_id,admin_actor_id,created_at DESC) WHERE admin_actor_id IS NOT NULL;
CREATE TRIGGER execution_agent_workspace BEFORE INSERT OR UPDATE ON integration_calls FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_resources','entry_agent_id','id');
ALTER TABLE integration_model_calls ALTER COLUMN app_id DROP NOT NULL;
-- Standalone administrator conversations are not owned by an integration app.
ALTER TABLE chat_traces ALTER COLUMN application_id DROP NOT NULL;
CREATE FUNCTION enforce_execution_principal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.workspace_id,NEW.app_id,NEW.visitor_session_id,NEW.key_id,NEW.admin_actor_id,NEW.entry_agent_id,NEW.idempotency_key,NEW.fingerprint)
  IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.app_id,OLD.visitor_session_id,OLD.key_id,OLD.admin_actor_id,OLD.entry_agent_id,OLD.idempotency_key,OLD.fingerprint) THEN
  RAISE EXCEPTION 'Execution principal and request identity are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.admin_actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_members m JOIN admins a ON a.id=m.admin_id WHERE m.workspace_id=NEW.workspace_id AND m.admin_id=NEW.admin_actor_id AND a.disabled_at IS NULL) THEN
  RAISE EXCEPTION 'Administrator execution requires current workspace membership' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_principal_immutable BEFORE INSERT OR UPDATE ON integration_calls FOR EACH ROW EXECUTE FUNCTION enforce_execution_principal();
CREATE FUNCTION enforce_model_call_principal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.workspace_id,NEW.call_id,NEW.app_id) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.call_id,OLD.app_id) THEN
  RAISE EXCEPTION 'Model accounting owner is immutable' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM integration_calls c WHERE c.id=NEW.call_id AND c.workspace_id=NEW.workspace_id AND c.app_id IS NOT DISTINCT FROM NEW.app_id) THEN
  RAISE EXCEPTION 'Model accounting owner does not match execution' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER model_call_principal BEFORE INSERT OR UPDATE ON integration_model_calls FOR EACH ROW EXECUTE FUNCTION enforce_model_call_principal();

CREATE TABLE chatbot_sessions(
 id UUID PRIMARY KEY,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 agent_id BIGINT NOT NULL REFERENCES agent_resources(id),
 admin_actor_id BIGINT REFERENCES admins(id),
 application_id UUID REFERENCES integration_apps(id),
 visitor_session_id UUID,
 title VARCHAR(160) NOT NULL DEFAULT '新会话' CHECK(length(btrim(title))>0),
 title_is_default BOOLEAN NOT NULL DEFAULT true,
 deleted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(visitor_session_id,application_id) REFERENCES visitor_sessions(id,application_id),
 CHECK((admin_actor_id IS NOT NULL AND application_id IS NULL AND visitor_session_id IS NULL) OR
       (admin_actor_id IS NULL AND application_id IS NOT NULL AND visitor_session_id IS NOT NULL))
);
CREATE INDEX chatbot_sessions_admin ON chatbot_sessions(workspace_id,admin_actor_id,updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX chatbot_sessions_visitor ON chatbot_sessions(workspace_id,application_id,visitor_session_id,updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE chatbot_turns(
 id UUID PRIMARY KEY REFERENCES integration_calls(id),
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 session_id UUID NOT NULL REFERENCES chatbot_sessions(id),
 request_id UUID NOT NULL,request_fingerprint CHAR(64) NOT NULL,
 agent_version_id BIGINT NOT NULL REFERENCES agent_resource_versions(id),
 question TEXT NOT NULL CHECK(length(btrim(question)) BETWEEN 1 AND 2000),
 partial_answer TEXT NOT NULL DEFAULT '' CHECK(length(partial_answer)<=200000),
 progress JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(progress)='array'),
 status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled','expired')),
 response JSONB,error_code VARCHAR(80),error_message VARCHAR(500),cancel_requested_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),finished_at TIMESTAMPTZ,
 UNIQUE(session_id,request_id)
);
CREATE INDEX chatbot_turns_session ON chatbot_turns(workspace_id,session_id,created_at,id);
CREATE TRIGGER chatbot_session_agent_workspace BEFORE INSERT OR UPDATE ON chatbot_sessions FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_resources','agent_id','id');
CREATE TRIGGER chatbot_session_app_workspace BEFORE INSERT OR UPDATE ON chatbot_sessions FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('integration_apps','application_id','id');
CREATE TRIGGER chatbot_session_visitor_workspace BEFORE INSERT OR UPDATE ON chatbot_sessions FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('visitor_sessions','visitor_session_id','id');
CREATE TRIGGER chatbot_turn_session_workspace BEFORE INSERT OR UPDATE ON chatbot_turns FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('chatbot_sessions','session_id','id');
CREATE TRIGGER chatbot_turn_call_workspace BEFORE INSERT OR UPDATE ON chatbot_turns FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('integration_calls','id','id');
CREATE TRIGGER chatbot_turn_version_workspace BEFORE INSERT OR UPDATE ON chatbot_turns FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_resource_versions','agent_version_id','id');
CREATE TABLE chatbot_events(
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 session_id UUID NOT NULL REFERENCES chatbot_sessions(id),
 actor_kind VARCHAR(20) NOT NULL CHECK(actor_kind IN ('admin','visitor')),
 actor_id VARCHAR(80) NOT NULL,
 action VARCHAR(40) NOT NULL CHECK(action IN ('created','renamed','deleted')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chatbot_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON chatbot_events USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled));
CREATE TRIGGER chatbot_event_session_workspace BEFORE INSERT ON chatbot_events FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('chatbot_sessions','session_id','id');
GRANT SELECT,INSERT ON chatbot_events TO agent_studio_workspace_runtime;
GRANT USAGE,SELECT ON SEQUENCE chatbot_events_id_seq TO agent_studio_workspace_runtime;
CREATE FUNCTION enforce_chatbot_principal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='chatbot_sessions' THEN
  IF TG_OP='INSERT' AND NEW.admin_actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_members m JOIN admins a ON a.id=m.admin_id WHERE m.workspace_id=NEW.workspace_id AND m.admin_id=NEW.admin_actor_id AND a.disabled_at IS NULL) THEN RAISE EXCEPTION 'Chat session requires current administrator membership' USING ERRCODE='23503'; END IF;
  IF TG_OP='INSERT' AND NEW.application_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM integration_apps a WHERE a.id=NEW.application_id AND a.agent_id=NEW.agent_id AND a.workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'Chat session must use application Agent' USING ERRCODE='23503'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.workspace_id,NEW.agent_id,NEW.admin_actor_id,NEW.application_id,NEW.visitor_session_id) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.agent_id,OLD.admin_actor_id,OLD.application_id,OLD.visitor_session_id) THEN
   RAISE EXCEPTION 'Chat session identity is immutable' USING ERRCODE='23514';
  END IF;
 ELSE
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.workspace_id,NEW.session_id,NEW.request_id,NEW.request_fingerprint,NEW.agent_version_id,NEW.question) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.session_id,OLD.request_id,OLD.request_fingerprint,OLD.agent_version_id,OLD.question) THEN
   RAISE EXCEPTION 'Chat turn input is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM chatbot_sessions s JOIN integration_calls c ON c.id=NEW.id JOIN agent_resource_versions v ON v.id=NEW.agent_version_id
    WHERE s.id=NEW.session_id AND s.workspace_id=NEW.workspace_id AND c.workspace_id=s.workspace_id AND v.resource_id=s.agent_id AND v.status='published'
    AND c.admin_actor_id IS NOT DISTINCT FROM s.admin_actor_id AND c.app_id IS NOT DISTINCT FROM s.application_id AND c.visitor_session_id IS NOT DISTINCT FROM s.visitor_session_id) THEN
   RAISE EXCEPTION 'Chat turn execution principal or published Agent does not match session' USING ERRCODE='23503';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chatbot_session_principal BEFORE INSERT OR UPDATE ON chatbot_sessions FOR EACH ROW EXECUTE FUNCTION enforce_chatbot_principal();
CREATE TRIGGER chatbot_turn_principal BEFORE INSERT OR UPDATE ON chatbot_turns FOR EACH ROW EXECUTE FUNCTION enforce_chatbot_principal();
ALTER TABLE chatbot_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE chatbot_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON chatbot_sessions USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled));
CREATE POLICY workspace_isolation ON chatbot_turns USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled));
GRANT SELECT,INSERT,UPDATE,DELETE ON chatbot_sessions,chatbot_turns TO agent_studio_workspace_runtime;
INSERT INTO permissions(code,description) VALUES('agent_chat.use','使用已发布 Agent 进行个人对话');
INSERT INTO role_permissions(role_id,permission_code) SELECT id,'agent_chat.use' FROM roles WHERE code='super_admin';

ALTER TABLE execution_artifacts ALTER COLUMN application_id DROP NOT NULL,ALTER COLUMN visitor_session_id DROP NOT NULL;
ALTER TABLE execution_artifacts ADD COLUMN admin_actor_id BIGINT REFERENCES admins(id);
ALTER TABLE execution_artifacts ADD CONSTRAINT artifact_principal_valid CHECK(
 (application_id IS NOT NULL AND visitor_session_id IS NOT NULL AND admin_actor_id IS NULL) OR
 (application_id IS NULL AND visitor_session_id IS NULL AND admin_actor_id IS NOT NULL AND source='generic_run'));
CREATE OR REPLACE FUNCTION enforce_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.admin_actor_id,NEW.id,NEW.workspace_id,NEW.trace_id,NEW.run_id,NEW.source,NEW.entry_version_id,NEW.producer_version_id,NEW.application_id,NEW.visitor_session_id,NEW.conversation_id,NEW.filename,NEW.mime_type,NEW.byte_size,NEW.sha256,NEW.expires_at,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.admin_actor_id,OLD.id,OLD.workspace_id,OLD.trace_id,OLD.run_id,OLD.source,OLD.entry_version_id,OLD.producer_version_id,OLD.application_id,OLD.visitor_session_id,OLD.conversation_id,OLD.filename,OLD.mime_type,OLD.byte_size,OLD.sha256,OLD.expires_at,OLD.created_at)
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
    AND c.app_id IS NOT DISTINCT FROM NEW.application_id AND c.visitor_session_id IS NOT DISTINCT FROM NEW.visitor_session_id AND c.admin_actor_id IS NOT DISTINCT FROM NEW.admin_actor_id AND c.conversation_id IS NULL AND c.status='running' AND c.expires_at>now()) THEN
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

-- Down Migration
DO $$ BEGIN IF EXISTS(SELECT 1 FROM integration_calls WHERE admin_actor_id IS NOT NULL) THEN RAISE EXCEPTION 'Administrator execution history exists; export and retain it before reverting this schema'; END IF; END $$;
DROP TABLE chatbot_events;
DROP TABLE chatbot_turns;
DROP TABLE chatbot_sessions;
DROP FUNCTION enforce_chatbot_principal();
DROP TRIGGER model_call_principal ON integration_model_calls;
DROP FUNCTION enforce_model_call_principal();
DROP TRIGGER execution_principal_immutable ON integration_calls;
DROP FUNCTION enforce_execution_principal();
DROP TRIGGER execution_agent_workspace ON integration_calls;
DROP INDEX administrator_call_idempotency;
DROP INDEX administrator_call_usage;
ALTER TABLE execution_artifacts DROP CONSTRAINT artifact_principal_valid;
CREATE OR REPLACE FUNCTION enforce_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER TABLE execution_artifacts DROP COLUMN admin_actor_id;
ALTER TABLE execution_artifacts ALTER COLUMN application_id SET NOT NULL,ALTER COLUMN visitor_session_id SET NOT NULL;
ALTER TABLE integration_calls DROP CONSTRAINT execution_principal_valid;
ALTER TABLE integration_calls DROP COLUMN admin_actor_id,DROP COLUMN entry_agent_id;
ALTER TABLE integration_calls ALTER COLUMN app_id SET NOT NULL,ALTER COLUMN visitor_session_id SET NOT NULL;
ALTER TABLE integration_model_calls ALTER COLUMN app_id SET NOT NULL;
ALTER TABLE chat_traces ALTER COLUMN application_id SET NOT NULL;
DELETE FROM role_permissions WHERE permission_code='agent_chat.use';
DELETE FROM permissions WHERE code='agent_chat.use';
