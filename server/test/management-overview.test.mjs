import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagementOverviewService } from '../dist/admin/management-overview.service.js';
import { AdminDashboardController } from '../dist/admin/admin-dashboard.controller.js';
function fixture(){const queries=[];return {queries,service:new ManagementOverviewService({query:async(sql,params)=>{queries.push({sql,params});return {rows:sql.includes('LIMIT 5')?[]:[{total:0}]};}})};}
test('management overview only queries authorised workspace sections',async()=>{
  const f=fixture();const hidden=await f.service.overview([]);
  assert.equal(hidden.agents,null);assert.equal(hidden.executions,null);assert.equal(hidden.knowledge,null);assert.equal(f.queries.length,0);
  const agents=await f.service.overview(['agent_config.read']);assert.equal(agents.executions,null);assert.equal(agents.knowledge,null);assert.equal(f.queries.length,2);
  for(const q of f.queries){assert.match(q.sql,/r.archived_at IS NULL AND r.deleted_at IS NULL/);assert.match(q.sql,/draft.config IS DISTINCT FROM current.config/);}
});
test('recent generic execution summaries omit inputs, payloads, debug state and unauthorised names',async()=>{
  const f=fixture();await f.service.overview(['conversations.read']);
  assert.equal(f.queries.length,2);
  const list=f.queries.find(q=>q.sql.includes('LIMIT 5')).sql;
  assert.doesNotMatch(list,/question|final_answer|\bcontext_snapshot\s+AS|agent_resources|agentName/);
  assert.match(list,/kind='answer'/);
  const both=fixture();await both.service.overview(['conversations.read','agent_config.read']);
  assert.ok(both.queries.some(q=>q.sql.includes('r.name AS "agentName"')));
});
test('knowledge attention excludes recycle bin and only reports the latest failed index',async()=>{
  const f=fixture();await f.service.overview(['documents.read']);
  assert.equal(f.queries.length,3);
  assert.ok(f.queries.filter(q=>q.sql.includes('documents d')).every(q=>q.sql.includes('d.deleted_at IS NULL')));
  const list=f.queries.find(q=>q.sql.includes('JOIN LATERAL')).sql;
  assert.match(list,/ORDER BY id DESC LIMIT 1/);assert.match(list,/v.status='failed'/);assert.doesNotMatch(list,/error_message|config|input_snapshot/);
});
test('management controller trusts guard-resolved workspace grants, not client query',async()=>{
  const calls=[];const controller=new AdminDashboardController({}, {}, {overview:p=>{calls.push(p);return {};}});
  controller.managementOverview({workspacePermissionCodes:['agent_config.read'],query:{permissionCodes:['conversations.read']}});
  assert.deepEqual(calls,[['agent_config.read']]);
});
