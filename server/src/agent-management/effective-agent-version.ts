/** Current entry configurations also pin historical member versions. Stopping
 * an entry keeps its references; archiving/deleting it releases them. RLS applies. */
export function effectiveAgentVersion(resource:string,version:string):string {
  if(!/^[a-z][a-z0-9_]*$/iu.test(resource)||!/^[a-z][a-z0-9_]*$/iu.test(version))throw new Error('Invalid SQL alias');
  return `(${resource}.current_version_id=${version}.id OR EXISTS(
    SELECT 1 FROM agent_resources coordinator JOIN agent_resource_versions composition ON composition.id=coordinator.current_version_id
    WHERE coordinator.workspace_id=${resource}.workspace_id AND coordinator.kind='agent' AND coordinator.archived_at IS NULL AND coordinator.deleted_at IS NULL
    AND composition.status='published' AND composition.config->'collaboration'->'memberVersionIds' @> jsonb_build_array(${version}.id)))`;
}
