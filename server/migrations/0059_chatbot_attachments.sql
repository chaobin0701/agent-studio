-- Up Migration
CREATE TABLE chatbot_attachments(
 id UUID PRIMARY KEY,
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 session_id UUID NOT NULL REFERENCES chatbot_sessions(id),
 name VARCHAR(240) NOT NULL,
 kind VARCHAR(12) NOT NULL CHECK(kind IN ('document','image')),
 mime_type VARCHAR(100) NOT NULL,
 byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880),
 sha256 CHAR(64) NOT NULL,
 content BYTEA,
 parsed_text TEXT CHECK(length(parsed_text)<=24000),
 status VARCHAR(12) NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','ready','failed','expired')),
 error_message VARCHAR(300),
 width INTEGER,height INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '7 days',
 purged_at TIMESTAMPTZ,
 CHECK((content IS NOT NULL AND purged_at IS NULL) OR (content IS NULL AND purged_at IS NOT NULL)),
 CHECK(content IS NULL OR octet_length(content)=byte_size),
 CHECK(status<>'ready' OR (content IS NOT NULL AND (kind='image' OR length(btrim(parsed_text))>0)))
);
CREATE INDEX chatbot_attachment_retention ON chatbot_attachments(expires_at,id) WHERE content IS NOT NULL;
CREATE INDEX chatbot_attachment_session ON chatbot_attachments(workspace_id,session_id,created_at);
CREATE TABLE chatbot_turn_attachments(
 workspace_id BIGINT NOT NULL DEFAULT current_workspace_id() REFERENCES workspaces(id),
 turn_id UUID NOT NULL REFERENCES chatbot_turns(id),
 attachment_id UUID NOT NULL REFERENCES chatbot_attachments(id),
 PRIMARY KEY(turn_id,attachment_id)
);
CREATE FUNCTION enforce_chatbot_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='chatbot_attachments' THEN
  IF TG_OP='INSERT' OR OLD.status='processing' AND NEW.content IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(245140,(NEW.workspace_id%2147483647)::int);
   IF NOT EXISTS(SELECT 1 FROM chatbot_sessions s WHERE s.id=NEW.session_id AND s.workspace_id=NEW.workspace_id AND s.deleted_at IS NULL) THEN RAISE EXCEPTION 'Attachment requires live owned session' USING ERRCODE='23503'; END IF;
   IF (SELECT count(*) FROM chatbot_attachments WHERE session_id=NEW.session_id AND content IS NOT NULL AND id<>NEW.id)>=100 OR
      (SELECT COALESCE(sum(byte_size),0) FROM chatbot_attachments WHERE session_id=NEW.session_id AND content IS NOT NULL AND id<>NEW.id)+NEW.byte_size>33554432 OR
      (SELECT COALESCE(sum(byte_size),0) FROM chatbot_attachments WHERE workspace_id=NEW.workspace_id AND content IS NOT NULL AND id<>NEW.id)+NEW.byte_size>134217728 THEN
     RAISE EXCEPTION 'Conversation attachment storage limit exceeded' USING ERRCODE='23514';
   END IF;
  END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.workspace_id,NEW.session_id,NEW.name,NEW.kind,NEW.created_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.session_id,OLD.name,OLD.kind,OLD.created_at,OLD.expires_at) OR OLD.status<>'processing' AND (NEW.content IS NOT NULL OR NEW.parsed_text IS NOT NULL OR NEW.status NOT IN ('expired','failed') OR NEW.purged_at IS NULL OR ROW(NEW.mime_type,NEW.byte_size,NEW.sha256,NEW.width,NEW.height) IS DISTINCT FROM ROW(OLD.mime_type,OLD.byte_size,OLD.sha256,OLD.width,OLD.height))) THEN
   RAISE EXCEPTION 'Ready attachment is immutable except content purge' USING ERRCODE='23514';
  END IF;
 ELSE
  IF TG_OP='UPDATE' OR NOT EXISTS(SELECT 1 FROM chatbot_turns t JOIN chatbot_attachments a ON a.id=NEW.attachment_id AND a.session_id=t.session_id WHERE t.id=NEW.turn_id AND t.workspace_id=NEW.workspace_id AND a.workspace_id=NEW.workspace_id AND a.status='ready' AND a.content IS NOT NULL AND a.expires_at>now()) THEN RAISE EXCEPTION 'Attachment is not ready in this turn session' USING ERRCODE='23503'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chatbot_attachment_guard BEFORE INSERT OR UPDATE ON chatbot_attachments FOR EACH ROW EXECUTE FUNCTION enforce_chatbot_attachment();
CREATE TRIGGER chatbot_turn_attachment_guard BEFORE INSERT OR UPDATE ON chatbot_turn_attachments FOR EACH ROW EXECUTE FUNCTION enforce_chatbot_attachment();
ALTER TABLE chatbot_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE chatbot_turn_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_turn_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON chatbot_attachments USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled));
CREATE POLICY workspace_isolation ON chatbot_turn_attachments USING(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled)) WITH CHECK(workspace_id=current_workspace_id() AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=workspace_id AND w.enabled));
GRANT SELECT,INSERT,UPDATE ON chatbot_attachments TO agent_studio_workspace_runtime;
GRANT SELECT,INSERT ON chatbot_turn_attachments TO agent_studio_workspace_runtime;
DO $$ BEGIN EXECUTE format($ddl$
 CREATE FUNCTION purge_unavailable_chatbot_attachments(batch_size integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO %I,pg_catalog SET row_security TO off AS $body$
 DECLARE affected integer;
 BEGIN
  WITH picked AS(SELECT a.id FROM chatbot_attachments a JOIN chatbot_sessions s ON s.id=a.session_id WHERE a.content IS NOT NULL AND (a.expires_at<=now() OR s.deleted_at IS NOT NULL OR a.status='processing' AND a.created_at<now()-interval '5 minutes') ORDER BY a.expires_at,a.id LIMIT GREATEST(1,LEAST(COALESCE(batch_size,100),100)) FOR UPDATE OF a SKIP LOCKED)
  UPDATE chatbot_attachments a SET content=NULL,parsed_text=NULL,purged_at=now(),status='expired' FROM picked p WHERE a.id=p.id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
 END $body$;
$ddl$,current_schema()); END $$;
REVOKE ALL ON FUNCTION purge_unavailable_chatbot_attachments(integer) FROM PUBLIC,agent_studio_workspace_runtime;
GRANT EXECUTE ON FUNCTION purge_unavailable_chatbot_attachments(integer) TO agent_studio_workspace_runtime;

-- Down Migration
DROP FUNCTION purge_unavailable_chatbot_attachments(integer);
DROP TABLE chatbot_turn_attachments;
DROP TABLE chatbot_attachments;
DROP FUNCTION enforce_chatbot_attachment();
