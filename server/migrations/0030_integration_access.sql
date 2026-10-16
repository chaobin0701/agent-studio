-- Up Migration
CREATE TABLE integration_apps (
  id uuid PRIMARY KEY,
  name varchar(100) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  website_enabled boolean NOT NULL DEFAULT false,
  api_enabled boolean NOT NULL DEFAULT false,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  scopes text[] NOT NULL DEFAULT '{chat:write,conversations:read,conversations:delete}',
  requests_per_minute integer NOT NULL DEFAULT 60 CHECK (requests_per_minute BETWEEN 1 AND 10000),
  concurrency integer NOT NULL DEFAULT 5 CHECK (concurrency BETWEEN 1 AND 100),
  daily_requests integer NOT NULL DEFAULT 5000 CHECK (daily_requests BETWEEN 1 AND 1000000),
  auth_version integer NOT NULL DEFAULT 1,
  is_internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_apps_internal ON integration_apps(is_internal) WHERE is_internal;
INSERT INTO integration_apps(id, name, website_enabled, is_internal)
VALUES ('00000000-0000-4000-8000-000000000001', '默认官网', true, true);

ALTER TABLE visitor_sessions ADD COLUMN application_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES integration_apps(id);
ALTER TABLE visitor_sessions ADD COLUMN external_user_id varchar(128);
ALTER TABLE visitor_sessions ADD COLUMN credential_expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days';
CREATE UNIQUE INDEX visitor_application_user ON visitor_sessions(application_id, external_user_id) WHERE external_user_id IS NOT NULL;
ALTER TABLE visitor_sessions ADD CONSTRAINT visitor_application_pair UNIQUE(id, application_id);
ALTER TABLE conversations ADD COLUMN application_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES integration_apps(id);
ALTER TABLE conversations ADD CONSTRAINT conversation_application_owner FOREIGN KEY(visitor_session_id, application_id) REFERENCES visitor_sessions(id, application_id) ON DELETE CASCADE;
ALTER TABLE chat_traces ADD COLUMN application_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES integration_apps(id);
-- Derive provenance from the authoritative owner, including existing conversation/summary writers.
CREATE FUNCTION assign_conversation_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT application_id INTO NEW.application_id FROM visitor_sessions WHERE id = NEW.visitor_session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_application BEFORE INSERT ON conversations FOR EACH ROW EXECUTE FUNCTION assign_conversation_application();
CREATE FUNCTION assign_trace_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    SELECT application_id INTO NEW.application_id FROM conversations WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trace_application BEFORE INSERT ON chat_traces FOR EACH ROW EXECUTE FUNCTION assign_trace_application();
CREATE INDEX conversations_application_updated ON conversations(application_id, updated_at DESC);

CREATE TABLE integration_api_keys (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES integration_apps(id),
  name varchar(100) NOT NULL,
  secret_hash char(64) NOT NULL UNIQUE,
  masked_key varchar(40) NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_keys_app ON integration_api_keys(app_id);

CREATE TABLE integration_calls (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES integration_apps(id),
  visitor_session_id uuid NOT NULL REFERENCES visitor_sessions(id),
  key_id uuid REFERENCES integration_api_keys(id),
  idempotency_key varchar(120) NOT NULL,
  fingerprint char(64) NOT NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status varchar(20) NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  response jsonb,
  run_id uuid,
  trace_id uuid,
  total_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(app_id, visitor_session_id, idempotency_key),
  FOREIGN KEY(visitor_session_id, app_id) REFERENCES visitor_sessions(id, application_id)
);
CREATE INDEX integration_calls_usage ON integration_calls(app_id, created_at DESC);
CREATE INDEX integration_calls_active ON integration_calls(app_id, expires_at) WHERE status = 'running';
INSERT INTO permissions(code, description) VALUES
  ('integrations.read', '查看接入应用、授权与调用统计'),
  ('integrations.manage', '管理接入应用、域名与 API 密钥') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p WHERE r.code = 'super_admin' AND p.code IN ('integrations.read','integrations.manage') ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM role_permissions WHERE permission_code IN ('integrations.read','integrations.manage');
DELETE FROM permissions WHERE code IN ('integrations.read','integrations.manage');
DROP TABLE integration_calls;
DROP TABLE integration_api_keys;
DROP TRIGGER trace_application ON chat_traces;
DROP FUNCTION assign_trace_application();
DROP TRIGGER conversation_application ON conversations;
DROP FUNCTION assign_conversation_application();
ALTER TABLE chat_traces DROP COLUMN application_id;
ALTER TABLE conversations DROP CONSTRAINT conversation_application_owner;
ALTER TABLE conversations DROP COLUMN application_id;
ALTER TABLE visitor_sessions DROP CONSTRAINT visitor_application_pair;
DROP INDEX visitor_application_user;
ALTER TABLE visitor_sessions DROP COLUMN application_id, DROP COLUMN external_user_id, DROP COLUMN credential_expires_at;
DROP TABLE integration_apps;
