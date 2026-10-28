-- Up Migration
UPDATE permissions SET description='访问 LangSmith 执行追踪（平台权限，仍需工作区读取权限）' WHERE code='observability.external.read';

-- Down Migration
UPDATE permissions SET description='访问本地 Phoenix 执行追踪（平台权限，仍需本地工作区读取权限）' WHERE code='observability.external.read';
