-- Up Migration
INSERT INTO permissions(code,description) VALUES('observability.external.read','访问本地 Phoenix 执行追踪（平台权限，仍需本地工作区读取权限）');
INSERT INTO role_permissions(role_id,permission_code)
 SELECT id,'observability.external.read' FROM roles WHERE code='super_admin';

-- Down Migration
DELETE FROM role_permissions WHERE permission_code='observability.external.read';
DELETE FROM permissions WHERE code='observability.external.read';
