-- Up Migration
-- One-way retirement of platform-installed business capabilities. Published
-- versions/traces stay immutable; no automatic replacement or permission grant.
SET LOCAL row_security = off;
CREATE TEMP TABLE retired_business_resources ON COMMIT DROP AS
 SELECT r.id,r.workspace_id,r.kind FROM agent_resources r WHERE
 (r.kind='agent' AND r.resource_key='default_support') OR
 (r.kind='skill' AND r.resource_key IN ('product_consultation','customer_support')) OR
 (r.kind='tool' AND (r.resource_key IN ('list_product_categories','list_products','get_product_detail',
  'mcp_product_catalog_list_product_categories','mcp_product_catalog_list_products','mcp_product_catalog_get_product_detail')
  OR (SELECT v.config->'endpoint'->>'connection' FROM agent_resource_versions v WHERE v.resource_id=r.id ORDER BY v.version DESC LIMIT 1)='application'));
CREATE TEMP TABLE retired_business_versions ON COMMIT DROP AS
 SELECT v.id,r.workspace_id FROM agent_resource_versions v JOIN agent_resources r ON r.id=v.resource_id
 WHERE r.id IN(SELECT id FROM retired_business_resources) OR (r.kind='tool' AND v.config->'endpoint'->>'connection'='application');
-- Disable affected active Agents (including transitive collaboration members),
-- without rewriting their published configuration. They must be reconfigured.
CREATE TEMP TABLE affected_business_agents ON COMMIT DROP AS
 WITH RECURSIVE affected(id) AS (
  SELECT r.id FROM agent_resources r WHERE r.kind='agent' AND
   (r.resource_key='default_support' OR EXISTS(SELECT 1 FROM agent_resource_versions v
    WHERE v.id=r.current_version_id AND EXISTS(SELECT 1 FROM retired_business_versions old
     WHERE old.workspace_id=r.workspace_id AND
      ((COALESCE(v.config->'toolVersionIds','[]'::jsonb) || COALESCE(v.config->'skillVersionIds','[]'::jsonb)) @> jsonb_build_array(old.id)))))
  UNION
  SELECT r.id FROM agent_resources r JOIN agent_resource_versions v ON v.id=r.current_version_id
   JOIN affected a ON EXISTS(SELECT 1 FROM agent_resource_versions av WHERE av.resource_id=a.id
    AND COALESCE(v.config->'collaboration'->'memberVersionIds','[]'::jsonb) @> jsonb_build_array(av.id))
 ) SELECT id FROM affected;
UPDATE integration_apps SET enabled=false,auth_version=auth_version+1,updated_at=now()
 WHERE agent_id IN(SELECT id FROM affected_business_agents);
DELETE FROM agent_environment_bindings WHERE agent_id IN(SELECT id FROM affected_business_agents);
DELETE FROM agent_application_bindings WHERE version_id IN(
 SELECT id FROM agent_resource_versions WHERE resource_id IN(SELECT id FROM affected_business_agents));
UPDATE agent_resources SET enabled=false,current_version_id=NULL WHERE id IN(SELECT id FROM affected_business_agents);
UPDATE agent_resources SET enabled=false,current_version_id=NULL,deleted_at=COALESCE(deleted_at,now())
 WHERE id IN(SELECT id FROM retired_business_resources);
-- No catalog is owned by the platform after this migration. Export before deploying.
DROP TABLE catalog_products;
DELETE FROM mcp_capabilities WHERE id='product_catalog';
ALTER TABLE model_bindings DROP CONSTRAINT model_bindings_purpose_check;
UPDATE model_bindings SET purpose='default' WHERE purpose='customer_support';
ALTER TABLE model_bindings ADD CONSTRAINT model_bindings_purpose_check CHECK(purpose='default');
-- Remove legacy business-only settings, not user-created Agent/Prompt resources.
DELETE FROM agent_settings WHERE configuration->'runtime'->'allowedTools' ?| ARRAY[
 'list_product_categories','list_products','get_product_detail','mcp_product_catalog_list_products',
 'mcp_product_catalog_list_product_categories','mcp_product_catalog_get_product_detail'];
INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details,workspace_id)
 SELECT (SELECT min(id) FROM admins),'platform.business_removed','platform','embedded_business',jsonb_build_object(
 'retiredResourceCount',(SELECT count(*) FROM retired_business_resources r WHERE r.workspace_id=w.id),
 'deactivatedAgentCount',(SELECT count(*) FROM affected_business_agents a JOIN agent_resources r ON r.id=a.id WHERE r.workspace_id=w.id),
 'publishedHistoryPreserved',true,'source','system_migration'),w.id FROM workspaces w WHERE EXISTS(SELECT 1 FROM admins);

-- Down Migration
-- Destructive cleanup is intentionally not reversible by inventing sample data.
DO $$ BEGIN RAISE EXCEPTION 'Restore the pre-migration backup to recover removed business data'; END $$;
