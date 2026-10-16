-- Up Migration
CREATE TABLE llm_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  provider_key VARCHAR(80) NOT NULL DEFAULT 'openai-compatible',
  adapter_type VARCHAR(80) NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT NOT NULL,
  model VARCHAR(200) NOT NULL,
  api_key_ciphertext TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 20000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  context_window_tokens INTEGER NOT NULL DEFAULT 32000 CHECK (context_window_tokens BETWEEN 1024 AND 1000000),
  max_output_tokens INTEGER NOT NULL DEFAULT 1200 CHECK (max_output_tokens BETWEEN 128 AND 32000),
  structured_output VARCHAR(20) NOT NULL DEFAULT 'auto' CHECK (structured_output IN ('auto', 'required', 'disabled')),
  supports_tool_calls BOOLEAN NOT NULL DEFAULT TRUE,
  supports_streaming BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (provider_key = 'openai-compatible' AND adapter_type = 'openai-compatible')
);
CREATE UNIQUE INDEX llm_profiles_one_default ON llm_profiles (is_default) WHERE is_default = TRUE AND enabled = TRUE;
CREATE INDEX llm_profiles_enabled_idx ON llm_profiles (enabled, updated_at DESC);

INSERT INTO permissions (code, description) VALUES
  ('model_profiles.read', '查看模型服务配置'),
  ('model_profiles.manage', '配置和切换模型服务')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_code)
SELECT roles.id, permissions.code
FROM roles CROSS JOIN permissions
WHERE roles.code = 'super_admin' AND permissions.code IN ('model_profiles.read', 'model_profiles.manage')
ON CONFLICT DO NOTHING;

-- Down Migration
DROP TABLE llm_profiles;
