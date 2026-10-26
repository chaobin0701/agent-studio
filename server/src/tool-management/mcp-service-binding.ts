import type { McpDefinition } from './remote-mcp';
export type McpBindingVersion = { id:number; serverId:number; name:string; version:number; catalog:McpDefinition[];enabled?:boolean;archivedAt?:unknown;deletedAt?:unknown };
export type McpBindingCapability = { id:number; version:number; target:string; mcpVersionId:number;enabled?:boolean };
/** UI binds a complete immutable connection version, never a list of methods. */
export function mcpServiceBindings(versions:McpBindingVersion[], capabilities:McpBindingCapability[]) {
  return versions.filter(version=>version.catalog.length>0).map(version=>{
    const toolVersionIds=version.catalog.map(definition=>capabilities.filter(item=>item.enabled!==false&&item.mcpVersionId===version.id&&item.target===definition.name).sort((a,b)=>b.version-a.version||b.id-a.id)[0]?.id).filter((id):id is number=>id!==undefined);
    const allToolVersionIds=capabilities.filter(item=>item.mcpVersionId===version.id).map(item=>item.id);
    const enabled=version.enabled!==false&&!version.archivedAt&&!version.deletedAt;
    return {id:version.id,serverId:version.serverId,name:version.name,version:version.version,capabilityCount:version.catalog.length,toolVersionIds,allToolVersionIds,enabled,ready:enabled&&toolVersionIds.length===version.catalog.length};
  });
}
