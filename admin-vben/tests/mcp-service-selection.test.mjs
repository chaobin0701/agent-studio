import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedMcpServices,selectMcpServices } from '../apps/web-ele/src/views/resources/mcp-service-selection.ts';
const choices=[{id:4,serverId:1,name:'Robot',version:2,capabilityCount:2,toolVersionIds:[12,13],allToolVersionIds:[11,12,13],ready:true},{id:5,serverId:2,name:'Other',version:1,capabilityCount:2,toolVersionIds:[21,22],allToolVersionIds:[21,22],ready:true}];
test('MCP capabilities collapse to one service and add/remove as a complete catalog',()=>{
  assert.deepEqual(selectedMcpServices([1,11,13],choices),[4]);
  assert.deepEqual(selectMcpServices([1], [4],choices),[1,12,13]);
  assert.deepEqual(selectMcpServices([1,11,13],[],choices),[1]);
});
test('adding another MCP never expands an unchanged partial or old legacy grant',()=>{
  assert.deepEqual(selectMcpServices([1,11],[4,5],choices),[1,11,21,22]);
});
test('incomplete catalogs and multiple versions of one server cannot be newly selected',()=>{
  assert.throws(()=>selectMcpServices([],[4],[{...choices[0],ready:false}]),/发布完整/);
  assert.throws(()=>selectMcpServices([],[4,6],[...choices,{...choices[0],id:6}]),/只能选择一个版本/);
});
