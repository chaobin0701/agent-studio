-- Up Migration
CREATE TABLE system_mcp_credentials (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  workspace_ids BIGINT[] NOT NULL,
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX system_mcp_credentials_admin_idx ON system_mcp_credentials(admin_id, created_at DESC);

CREATE TABLE system_mcp_recording_policy (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  audit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  conversation_content_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  trace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  usage_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by BIGINT REFERENCES admins(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_mcp_recording_policy(id) VALUES (1);

-- Down Migration
DROP TABLE system_mcp_recording_policy;
DROP TABLE system_mcp_credentials;
