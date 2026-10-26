import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpServiceBindings } from '../dist/tool-management/mcp-service-binding.js';
import { ToolManagementService } from '../dist/tool-management/tool-management.service.js';
const schema={type:'object',properties:{}};
const version={id:4,serverId:1,name:'Robot MCP',key:'robot',version:2,enabled:true,config:{url:'https://example.test/mcp',timeoutMs:15000,credentialId:null},catalog:[{name:'users',inputSchema:schema},{name:'records',inputSchema:schema}]};
test('one connection version is one choice; readiness requires the complete catalog and keeps old version identities',()=>{
  const rows=[{id:11,version:1,target:'users',mcpVersionId:4},{id:12,version:2,target:'users',mcpVersionId:4},{id:13,version:1,target:'records',mcpVersionId:4}];
  const [complete]=mcpServiceBindings([version],rows);
  assert.equal(complete.capabilityCount,2);assert.equal(complete.ready,true);
  assert.deepEqual(complete.toolVersionIds,[12,13]);assert.deepEqual(complete.allToolVersionIds,[11,12,13]);
  assert.equal(mcpServiceBindings([version],rows.slice(0,2))[0].ready,false);
  assert.deepEqual(mcpServiceBindings([{...version,catalog:[]}],rows),[]);
  const [disabled]=mcpServiceBindings([version],rows.map(item=>item.target==='records'?{...item,enabled:false}:item));
  assert.equal(disabled.ready,false);assert.ok(disabled.allToolVersionIds.includes(13));
  assert.equal(mcpServiceBindings([{...version,enabled:false}],rows)[0].ready,false);
});
function fixture({latest=4,existing}={}) {
  const configs=[],calls=[];
  let next=100;
  const db={async transaction(work){return work(this);},async query(sql,values){
    calls.push(sql);
    if(sql.includes('FROM mcp_servers WHERE'))return{rows:[{id:1}]};
    if(sql.includes('FROM mcp_server_versions WHERE'))return{rows:[{id:latest}]};
    if(sql.includes("v.config->>'target'=$2"))return{rows:existing?[{id:existing}]:[]};
    if(sql.includes('INSERT INTO agent_resources'))return{rows:[{id:9,enabled:true}]};
    if(sql.includes('COALESCE(max(version)'))return{rows:[{n:1}]};
    if(sql.includes('INSERT INTO agent_resource_versions')){configs.push(JSON.parse(values[2]));return{rows:[{id:next++}]};}
    return{rows:[]};
  }};
  const service=new ToolManagementService(db,{});
  service.connectionVersion=async()=>version;
  return{service,configs,calls};
}
test('whole-service publication creates immutable adapters with approval on and never calls a remote method',async()=>{
  const f=fixture();const result=await f.service.publishService(1,1,{versionId:4});
  assert.deepEqual(result.toolVersionIds,[100,101]);assert.equal(f.configs.length,2);
  for(const config of f.configs){assert.equal(config.type,'mcp');assert.equal(config.requiresApproval,true);assert.equal(config.readOnly,false);assert.equal(config.maxRetries,0);}
});
test('whole-service publication preserves existing published policy and refuses a stale connection version',async()=>{
  const ready=fixture({existing:22});await ready.service.publishService(1,1,{versionId:4});assert.equal(ready.configs.length,0);
  const stale=fixture({latest:5});await assert.rejects(stale.service.publishService(1,1,{versionId:4}),error=>error.getStatus()===409);assert.equal(stale.configs.length,0);
});
