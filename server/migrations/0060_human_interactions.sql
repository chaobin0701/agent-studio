-- Up Migration
-- Private native LangGraph checkpoints. Public clients only see explicit cards.
ALTER TABLE integration_calls DROP CONSTRAINT integration_calls_status_check;
ALTER TABLE integration_calls ADD CONSTRAINT integration_calls_status_check CHECK(status IN ('running','waiting','completed','failed','expired'));
CREATE INDEX integration_calls_waiting ON integration_calls(workspace_id,expires_at) WHERE status='waiting';
CREATE TABLE agent_interaction_threads (
 run_id UUID PRIMARY KEY REFERENCES integration_calls(id) ON DELETE CASCADE,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 host_input JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(host_input)='object' AND octet_length(host_input::text)<=2097152),
 continuation JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(continuation)='object' AND octet_length(continuation::text)<=2097152),
 interrupt_id VARCHAR(200),
 status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK(status IN ('running','waiting','resuming','completed','cancelled','expired')),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE agent_native_checkpoints (
 run_id UUID NOT NULL REFERENCES agent_interaction_threads(run_id) ON DELETE CASCADE,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 namespace VARCHAR(1000) NOT NULL DEFAULT '',checkpoint_id VARCHAR(200) NOT NULL,parent_id VARCHAR(200),
 checkpoint_type VARCHAR(100) NOT NULL,checkpoint BYTEA NOT NULL CHECK(octet_length(checkpoint)<=4194304),
 metadata_type VARCHAR(100) NOT NULL,metadata BYTEA NOT NULL CHECK(octet_length(metadata)<=1048576),
 PRIMARY KEY(run_id,namespace,checkpoint_id)
);
CREATE TABLE agent_native_checkpoint_writes (
 -- Native LangGraph persists task writes and their checkpoint concurrently.
 -- Bind writes to the authorized thread, not to a checkpoint commit order.
 run_id UUID NOT NULL REFERENCES agent_interaction_threads(run_id) ON DELETE CASCADE,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 namespace VARCHAR(1000) NOT NULL DEFAULT '',checkpoint_id VARCHAR(200) NOT NULL,
 task_id VARCHAR(200) NOT NULL,task_path VARCHAR(2000) NOT NULL DEFAULT '',idx INTEGER NOT NULL,
 channel VARCHAR(300) NOT NULL,value_type VARCHAR(100) NOT NULL,value BYTEA NOT NULL CHECK(octet_length(value)<=4194304),
 PRIMARY KEY(run_id,namespace,checkpoint_id,task_id,idx)
);
CREATE TABLE agent_interactions (
 id UUID PRIMARY KEY,run_id UUID NOT NULL REFERENCES agent_interaction_threads(run_id) ON DELETE CASCADE,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 interrupt_id VARCHAR(200) NOT NULL,request_key CHAR(64) NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 kind VARCHAR(20) NOT NULL CHECK(kind IN ('question','approval')),
 status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','approved','rejected','expired','cancelled')),
 request JSONB NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=65536),
 public_request JSONB NOT NULL CHECK(jsonb_typeof(public_request)='object' AND octet_length(public_request::text)<=65536),
 response JSONB,response_fingerprint CHAR(64),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),resolved_at TIMESTAMPTZ,
 UNIQUE(run_id,request_key)
);
CREATE INDEX agent_interactions_run ON agent_interactions(workspace_id,run_id,created_at,id);
CREATE UNIQUE INDEX agent_interactions_pending ON agent_interactions(run_id) WHERE status='pending';
CREATE INDEX agent_interaction_threads_expiry ON agent_interaction_threads(expires_at) WHERE status IN ('running','waiting','resuming');
ALTER TABLE chatbot_turns DROP CONSTRAINT chatbot_turns_status_check;
ALTER TABLE chatbot_turns ADD CONSTRAINT chatbot_turns_status_check CHECK(status IN ('running','waiting','completed','failed','cancelled','expired'));
ALTER TABLE conversation_runs DROP CONSTRAINT conversation_runs_status_check;
ALTER TABLE conversation_runs ADD CONSTRAINT conversation_runs_status_check CHECK(status IN ('queued','running','waiting','completed','failed','interrupted','expired'));
ALTER TABLE conversation_runs ADD COLUMN integration_call_id UUID REFERENCES integration_calls(id);
CREATE UNIQUE INDEX conversation_runs_integration_call ON conversation_runs(integration_call_id) WHERE integration_call_id IS NOT NULL;
CREATE TRIGGER interaction_legacy_call_workspace BEFORE INSERT OR UPDATE ON conversation_runs FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('integration_calls','integration_call_id','id');
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['agent_interaction_threads','agent_native_checkpoints','agent_native_checkpoint_writes','agent_interactions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY workspace_isolation ON %I USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled))',table_name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO agent_studio_workspace_runtime',table_name);
 END LOOP;
END $$;
CREATE TRIGGER interaction_checkpoint_workspace BEFORE INSERT OR UPDATE ON agent_native_checkpoints FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_interaction_threads','run_id','run_id');
CREATE TRIGGER interaction_thread_execution_workspace BEFORE INSERT OR UPDATE ON agent_interaction_threads FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('integration_calls','run_id','id');
CREATE TRIGGER interaction_write_workspace BEFORE INSERT OR UPDATE ON agent_native_checkpoint_writes FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_interaction_threads','run_id','run_id');
CREATE TRIGGER interaction_request_workspace BEFORE INSERT OR UPDATE ON agent_interactions FOR EACH ROW EXECUTE FUNCTION enforce_workspace_reference('agent_interaction_threads','run_id','run_id');

-- Down Migration
DO $$ BEGIN IF EXISTS(SELECT 1 FROM agent_interaction_threads) THEN RAISE EXCEPTION 'Interaction history exists; retain it before reverting'; END IF; END $$;
ALTER TABLE chatbot_turns DROP CONSTRAINT chatbot_turns_status_check;
ALTER TABLE chatbot_turns ADD CONSTRAINT chatbot_turns_status_check CHECK(status IN ('running','completed','failed','cancelled','expired'));
DROP TRIGGER interaction_legacy_call_workspace ON conversation_runs;
DROP INDEX conversation_runs_integration_call;
ALTER TABLE conversation_runs DROP COLUMN integration_call_id;
ALTER TABLE conversation_runs DROP CONSTRAINT conversation_runs_status_check;
ALTER TABLE conversation_runs ADD CONSTRAINT conversation_runs_status_check CHECK(status IN ('queued','running','completed','failed','interrupted','expired'));
DROP TABLE agent_interactions,agent_native_checkpoint_writes,agent_native_checkpoints,agent_interaction_threads;
DROP INDEX integration_calls_waiting;
ALTER TABLE integration_calls DROP CONSTRAINT integration_calls_status_check;
ALTER TABLE integration_calls ADD CONSTRAINT integration_calls_status_check CHECK(status IN ('running','completed','failed','expired'));
