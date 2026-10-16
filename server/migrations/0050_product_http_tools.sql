-- Up Migration
-- Never overwrite immutable releases, current Agent pointers or custom HTTP tools.
WITH candidates AS (
 SELECT r.id,r.workspace_id,r.resource_key,r.name,v.version,v.config
 FROM agent_resources r
 JOIN LATERAL(SELECT version,config FROM agent_resource_versions WHERE resource_id=r.id ORDER BY version DESC LIMIT 1)v ON true
 WHERE r.kind='tool' AND r.resource_key IN ('list_product_categories','list_products','get_product_detail')
 AND v.config->>'type'='builtin' AND v.config->>'target'=r.resource_key
), inserted AS (
 INSERT INTO agent_resource_versions(resource_id,workspace_id,version,status,config)
 SELECT id,workspace_id,version+1,'draft',
 (config-'target'-'mcpVersionId') || jsonb_build_object('type','rest','endpoint',jsonb_build_object(
 'connection','application','url','/api/tool-services/product-catalog/'||CASE resource_key WHEN 'list_product_categories' THEN 'categories' WHEN 'list_products' THEN 'products' ELSE 'detail' END,
 'method','GET','mappingMode','explicit','headers','{}'::jsonb,'resultPath','',
 'bindings',CASE resource_key WHEN 'list_product_categories' THEN '[]'::jsonb WHEN 'list_products' THEN '[{"source":"categoryId","location":"query","target":"categoryId"},{"source":"search","location":"query","target":"search"}]'::jsonb ELSE '[{"source":"productId","location":"query","target":"productId"},{"source":"productIds","location":"query","target":"productIds"}]'::jsonb END))
 FROM candidates RETURNING id,resource_id,workspace_id
)
INSERT INTO audit_logs(workspace_id,actor_admin_id,action,target_type,target_id,details)
SELECT workspace_id,(SELECT min(id) FROM admins),'tool.product_http_migrated','agent_resource',resource_id::text,jsonb_build_object('versionId',id,'status','draft','source','system_migration') FROM inserted WHERE EXISTS(SELECT 1 FROM admins);

-- Down Migration
-- Forward-only data migration: historical HTTP/published versions remain valid.
SELECT 1;
