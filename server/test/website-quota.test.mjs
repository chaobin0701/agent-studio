import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationService } from '../dist/integrations/integration.service.js';
import { ChatController } from '../dist/chat/chat.controller.js';
const app = { id:'current-app', dailyRequests:100, dailyTokenLimit:1000, scopes:['conversations:read'], allowedOrigins:['private'], secret:'not-public' };
const identity = { app, kind:'website', ownerId:'current-owner', scopes:['conversations:read'] };
function fixture() {
  const queries=[];
  const access = new IntegrationService({ query:async(sql,values)=>{ queries.push({sql,values});return { rows:[{requests:7}] }; } }, {}, {}, {
    daily:async(appId)=>{assert.equal(appId,app.id);return {startAt:'2026-10-08T00:00:00+08:00',resetAt:'2026-10-09T00:00:00+08:00',timezone:'Asia/Shanghai',totalTokens:400,reservedTokens:100,unknownModelCalls:1,inputTokens:300,outputTokens:100};},
  });
  access.app=async(id)=>{assert.equal(id,app.id);return app;};
  return {access,queries};
}
test('published website quota includes shared budget only, never keys/users/settings/other apps',async()=>{
  const {access,queries}=fixture();
  const result=await access.publicWebsiteQuota(identity);
  assert.equal(result.scope,'website-shared');assert.equal(result.requests,7);assert.equal(result.requestLimit,100);assert.equal(result.remainingRequests,93);
  assert.equal(result.tokenLimit,1000);assert.equal(result.remainingTokens,500);assert.equal(result.unknownModelCalls,1);
  assert.deepEqual(queries[0].values,[app.id]);
  for(const key of ['app','ownerId','allowedOrigins','secret','inputTokens','outputTokens','scopes'])assert.equal(key in result,false);
  assert.equal(JSON.stringify(result).includes('current-owner'),false);
});
test('website shared query cannot be used by platform keys, missing visitor or missing read permission',async()=>{
  const {access}=fixture();
  for(const invalid of [{...identity,kind:'api'},{...identity,ownerId:undefined},{...identity,scopes:[]}])await assert.rejects(access.publicWebsiteQuota(invalid),e=>e.getStatus()===403);
});
test('cookie status/usage/quota reuse the established visitor identity without new conversations',async()=>{
  const seen=[];
  const access={ publicStatus:async(id)=>{seen.push(['status',id]);return {};},publicUsage:async(id)=>{seen.push(['usage',id]);return {};},publicWebsiteQuota:async(id)=>{seen.push(['quota',id]);return {};} };
  const sessions={session:async(req,res)=>{assert.equal(req.headers.cookie,'existing-private-cookie');assert.ok(res);return 'cookie-owner';}};
  const controller=new ChatController({}, {}, sessions, {}, undefined, undefined, undefined, access);
  const request={integration:{...identity,ownerId:undefined},headers:{cookie:'existing-private-cookie'},query:{appId:'other-app',userId:'other-owner'}};
  await controller.status(request,{});await controller.usage(request,{});await controller.quota(request,{});
  assert.deepEqual(seen.map(([name])=>name),['status','usage','quota']);
  assert.ok(seen.every(([,id])=>id.ownerId==='cookie-owner'&&id.app.id===app.id));
  assert.equal(request.integration.ownerId,undefined);
});
