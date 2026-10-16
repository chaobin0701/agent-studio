import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpPluginRegistry } from '../dist/ai/mcp/mcp-plugin-registry.js';
import { adaptMcpTool } from '../dist/ai/mcp/mcp-tool.adapter.js';
import { McpModule } from '../dist/ai/mcp/mcp.module.js';
import { ToolRegistry } from '../dist/ai/tools/tool-registry.js';

test('empty protocol registry installs no implicit business capability',async()=>{
 const plugins=new McpPluginRegistry(),tools=new ToolRegistry();
 const module=new McpModule(plugins,tools,{publishEvent:()=>{throw Error('unexpected event')}});
 await module.onModuleInit();assert.deepEqual(tools.list(),[]);assert.deepEqual(plugins.list(),[]);
 await module.onApplicationShutdown();
});
test('an explicitly installed generic MCP tool discovers and executes through the protocol',async t=>{
 const plugins=new McpPluginRegistry();
 plugins.register({id:'records',version:'1',enabled:true,createServer:()=>{
  const server=new McpServer({name:'records',version:'1'});
  server.registerTool('read_record',{description:'Read record',inputSchema:{id:z.string()}},async({id})=>({content:[{type:'text',text:JSON.stringify({id,value:'Verified'})}]}));
  return server;
 }});
 t.after(()=>plugins.stopAll());const client=await plugins.start('records');const {tools}=await client.listTools();
 const tool=adaptMcpTool('records',client,tools[0]);const result=await tool.execute({id:'r1'},{permissions:[],state:new Map()});
 assert.equal(result.success,true);assert.match(result.content,/Verified/);
});
test('disabled MCP plugins cannot start or grant a tool',async()=>{
 const plugins=new McpPluginRegistry();plugins.register({id:'disabled',version:'1',enabled:false,createServer:()=>{throw Error('must not start')}});
 assert.equal(await plugins.start('disabled'),null);
});
