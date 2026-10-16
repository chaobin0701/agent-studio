-- Up Migration
CREATE TABLE agent_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  configuration jsonb NOT NULL,
  revision varchar(12) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by bigint REFERENCES admins(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO permissions(code,description) VALUES ('agent_config.manage','修改 Agent 行为、记忆与能力配置') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_code) SELECT id,'agent_config.manage' FROM roles WHERE code='super_admin' ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM role_permissions WHERE permission_code='agent_config.manage';
DELETE FROM permissions WHERE code='agent_config.manage';
DROP TABLE agent_settings;
