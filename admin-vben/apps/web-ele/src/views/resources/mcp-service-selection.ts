export type McpServiceChoice = {
  id:number;serverId:number;name:string;version:number;capabilityCount:number;
  toolVersionIds:number[];allToolVersionIds:number[];ready:boolean;enabled?:boolean;
};
export function selectedMcpServices(toolVersionIds:number[],choices:McpServiceChoice[]) {
  return choices.filter(choice=>choice.allToolVersionIds.some(id=>toolVersionIds.includes(id))).map(choice=>choice.id);
}
/** Preserve unchanged legacy/partial grants. Only newly selected services expand
 * to the complete published catalog; removal drops all capabilities of that version. */
export function selectMcpServices(current:number[],selected:number[],choices:McpServiceChoice[]) {
  const previous=new Set(selectedMcpServices(current,choices));
  const known=new Set(choices.flatMap(choice=>choice.allToolVersionIds));
  const result=current.filter(id=>!known.has(id));
  const servers=new Set<number>();
  for(const id of selected) {
    const choice=choices.find(item=>item.id===id);
    if(!choice) throw new Error('MCP 服务版本不可用');
    if(servers.has(choice.serverId)) throw new Error('同一 MCP 服务只能选择一个版本');
    servers.add(choice.serverId);
    if(previous.has(id)) result.push(...current.filter(versionId=>choice.allToolVersionIds.includes(versionId)));
    else {
      if(!choice.ready) throw new Error('请先在 MCP 管理中发布完整服务目录');
      result.push(...choice.toolVersionIds);
    }
  }
  return [...new Set(result)];
}
