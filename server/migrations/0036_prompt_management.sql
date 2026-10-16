-- Up Migration
CREATE TABLE prompt_resources (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_key VARCHAR(160) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  prompt_type VARCHAR(32) NOT NULL CHECK (prompt_type IN ('system','planner','answer','tool','summary','classification','guardrail','welcome')),
  description TEXT NOT NULL DEFAULT '',
  created_by BIGINT REFERENCES admins(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE prompt_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource_id BIGINT NOT NULL REFERENCES prompt_resources(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  template TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  change_note TEXT NOT NULL DEFAULT '',
  created_by BIGINT REFERENCES admins(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE(resource_id, version)
);
CREATE TABLE prompt_environment_bindings (
  environment VARCHAR(32) NOT NULL CHECK (environment IN ('dev','test','prod')),
  resource_id BIGINT NOT NULL REFERENCES prompt_resources(id) ON DELETE CASCADE,
  version_id BIGINT NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  updated_by BIGINT REFERENCES admins(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(environment, resource_id)
);
CREATE INDEX prompt_versions_resource_idx ON prompt_versions(resource_id, version DESC);
CREATE INDEX prompt_bindings_version_idx ON prompt_environment_bindings(version_id);
CREATE OR REPLACE FUNCTION prevent_published_prompt_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN RAISE EXCEPTION 'Published prompt versions are immutable'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE OR DELETE ON prompt_versions
FOR EACH ROW EXECUTE FUNCTION prevent_published_prompt_change();
INSERT INTO permissions(code, description) VALUES
  ('prompts.read', '查看 Prompt 资源和版本'),
  ('prompts.manage', '编辑、测试和发布 Prompt')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE r.code='super_admin' AND p.code IN ('prompts.read','prompts.manage')
ON CONFLICT DO NOTHING;

-- Down Migration
DROP TRIGGER prompt_versions_immutable ON prompt_versions;
DROP FUNCTION prevent_published_prompt_change;
DROP TABLE prompt_environment_bindings, prompt_versions, prompt_resources;
DELETE FROM role_permissions WHERE permission_code IN ('prompts.read','prompts.manage');
DELETE FROM permissions WHERE code IN ('prompts.read','prompts.manage');
