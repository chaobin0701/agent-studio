-- Up Migration
ALTER TABLE model_accounts ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE model_deployments ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN test_result JSONB, ADD COLUMN tested_at TIMESTAMPTZ;
ALTER TABLE model_plans ADD COLUMN deleted_at TIMESTAMPTZ, ADD COLUMN archived_at TIMESTAMPTZ,
  ADD COLUMN current_version_id BIGINT REFERENCES model_plan_versions(id);
UPDATE model_plans p SET current_version_id=(SELECT v.id FROM model_plan_versions v
  WHERE v.plan_id=p.id AND v.status='published' ORDER BY v.version DESC LIMIT 1);
-- Access to a model list never grants access to plaintext credentials.
INSERT INTO permissions(code,description) VALUES('model_credentials.reveal','查看和复制模型凭据');
INSERT INTO role_permissions(role_id,permission_code)
  SELECT id,'model_credentials.reveal' FROM roles WHERE code='super_admin' ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM role_permissions WHERE permission_code='model_credentials.reveal';
DELETE FROM permissions WHERE code='model_credentials.reveal';
ALTER TABLE model_plans DROP COLUMN current_version_id,DROP COLUMN deleted_at,DROP COLUMN archived_at;
ALTER TABLE model_deployments DROP COLUMN deleted_at,DROP COLUMN archived_at,DROP COLUMN test_result,DROP COLUMN tested_at;
ALTER TABLE model_accounts DROP COLUMN deleted_at,DROP COLUMN archived_at;
