-- Up Migration
INSERT INTO permissions (code, description)
VALUES ('agent_config.read', '查看 Agent 人设、记忆与运行配置')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_code)
SELECT id, 'agent_config.read' FROM roles WHERE code = 'super_admin'
ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM role_permissions WHERE permission_code = 'agent_config.read';
DELETE FROM permissions WHERE code = 'agent_config.read';
