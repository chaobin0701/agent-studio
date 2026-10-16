import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PromptService } from '../dist/prompts/prompt.service.js';
import { PromptController } from '../dist/prompts/prompt.controller.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';
import { AgentManagementService } from '../dist/agent-management/agent-management.service.js';

test('Prompt preview, publish review and draft preparation retain existing permission boundaries',()=>{
  for(const method of ['create','update','draft','review','publish'])assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY,PromptController.prototype[method]),['prompts.manage']);
  for(const method of ['preview','usage'])assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY,PromptController.prototype[method]),['prompts.read','prompts.manage']);
});

test('PostgreSQL Prompt workflow: typed-free creation, draft revisions, atomic publication, stable references and preview', {skip:process.env.KB_INTEGRATION!=='1'}, async t=>{
  const client=new Client({host:process.env.POSTGRES_HOST??'localhost',port:Number(process.env.POSTGRES_PORT??5433),user:process.env.POSTGRES_USER??'grounded',password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB??'agent_studio'});
  await client.connect();
  try {
    await client.query('BEGIN');const schema='prompt_test_'+randomUUID().replaceAll('-','');await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path TO "${schema}",public`);
    const directory=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await client.query((await readFile(new URL(file,directory),'utf8')).split('-- Down Migration')[0]);
    const actor=(await client.query("INSERT INTO admins(email,password_hash,display_name) VALUES('prompt@example.invalid','fixture','Prompt reviewer') RETURNING id::int")).rows[0].id;
    const database={query:(sql,args)=>client.query(sql,args),transaction:async work=>{
      await client.query('SAVEPOINT prompt_call');try{const result=await work(client);await client.query('RELEASE SAVEPOINT prompt_call');return result;}catch(e){await client.query('ROLLBACK TO SAVEPOINT prompt_call');await client.query('RELEASE SAVEPOINT prompt_call');throw e;}
    }};
    const service=new PromptService(database);
    await t.test('retired internal templates retain history but cannot be mutated or loaded',async()=>{
      for(const key of ['agent.planner','agent.answer']) {
        const resource=(await client.query('SELECT id::int FROM prompt_resources WHERE prompt_key=$1',[key])).rows[0];
        assert.ok(resource);
        const detail=await service.get(resource.id),v=detail.versions[0];
        assert.ok(v.template);assert.equal(detail.isPlatform,true);
        assert.equal((await service.list()).some(r=>r.promptKey===key),false);
        const denied=e=>e.getStatus()===409;
        await assert.rejects(service.createVersion(actor,resource.id,{template:'override',variables:{}}),denied);
        await assert.rejects(service.clone(actor,v.versionId),denied);
        await assert.rejects(service.prepareDraft(actor,v.versionId),denied);
        await assert.rejects(service.updateDraft(actor,v.versionId,{template:'override',variables:{}}),denied);
        await assert.rejects(service.review(v.versionId,{template:'override',variables:{},expectedRevision:v.revision}),denied);
        await assert.rejects(service.publish(actor,v.versionId),denied);
        await assert.rejects(service.rollout(actor,v.versionId,'dev'),denied);
        assert.equal(await service.active('dev',key),null);
        assert.deepEqual(await service.get(resource.id),detail);
      }
    });
    let resource,first;
    await t.test('new prompts require no type or Key, and reserved keys remain protected',async()=>{
      resource=await service.create(actor,{name:'Business prompt',template:'Original text'});
      const detail=await service.get(resource.id);first=detail.versions[0];
      assert.match(detail.promptKey,/^prompt\.[a-f0-9]+$/);assert.equal(detail.promptType,'system');assert.equal(detail.isPlatform,false);assert.equal(first.revision,1);
      await assert.rejects(service.create(actor,{name:'Reserved',promptKey:'agent.answer'}),e=>e.getStatus()===400);
    });
    await t.test('current unsaved preview does not write the draft and validates input types',async()=>{
      const result=await service.preview(resource.id,{template:'Hello {{name}}{{optional}}',variables:{name:{type:'string',required:true},optional:{type:'string',required:false}},values:{name:'Reader'}});
      assert.equal(result.text,'Hello Reader');assert.equal(result.saved,false);
      assert.equal((await service.get(resource.id)).versions[0].template,'Original text');
      await assert.rejects(service.preview(resource.id,{template:'{{name}}',variables:{name:{type:'string',required:true}},values:{name:42}}),e=>e.getStatus()===400&&/name/.test(e.message));
    });
    await t.test('draft revisions reject stale saves without losing the successful edit',async()=>{
      const result=await service.updateDraft(actor,first.versionId,{template:'Saved draft',variables:{},expectedRevision:1});assert.equal(result.revision,2);
      await assert.rejects(service.updateDraft(actor,first.versionId,{template:'Stale overwrite',variables:{},expectedRevision:1}),e=>e.getStatus()===409);
      assert.equal((await service.get(resource.id)).versions[0].template,'Saved draft');
    });
    await t.test('reviewed unsaved content is saved and published atomically; published versions stay immutable',async()=>{
      const content={template:'Reviewed unsaved content',variables:{},expectedRevision:2};const review=await service.review(first.versionId,content);
      assert.equal(review.agentSelectable,true);assert.equal(review.source.version,null);
      await service.publish(actor,first.versionId,{...content,reviewHash:review.reviewHash,changeNote:'首次发布业务指导'});
      const published=(await service.get(resource.id)).versions[0];assert.equal(published.status,'published');assert.equal(published.template,content.template);assert.equal(published.publishedBy,'Prompt reviewer');
      await assert.rejects(service.updateDraft(actor,first.versionId,{template:'Overwrite published',variables:{},expectedRevision:published.revision}),e=>e.getStatus()===409);
      await client.query('SAVEPOINT immutable_check');await assert.rejects(client.query('UPDATE prompt_versions SET template=$2 WHERE id=$1',[first.versionId,'forbidden']),/immutable/);await client.query('ROLLBACK TO SAVEPOINT immutable_check');await client.query('RELEASE SAVEPOINT immutable_check');
    });
    let second;
    await t.test('editing a published version prepares one reusable draft with an explicit source',async()=>{
      second=await service.prepareDraft(actor,first.versionId);assert.equal(second.reused,false);assert.equal(second.version,2);
      const again=await service.prepareDraft(actor,first.versionId);assert.equal(again.versionId,second.versionId);assert.equal(again.reused,true);
      const v=(await service.get(resource.id)).versions[0];assert.equal(v.sourceVersionId,first.versionId);assert.equal((await service.get(resource.id)).versions.length,2);
    });
    await t.test('publication rejects mismatched review hashes, missing notes and concurrent draft updates',async()=>{
      const content={template:'Second edition',variables:{},expectedRevision:1},review=await service.review(second.versionId,content);
      await assert.rejects(service.publish(actor,second.versionId,{...content,template:'Unreviewed text',reviewHash:review.reviewHash,changeNote:'Mismatch'}),e=>e.getStatus()===409);
      await assert.rejects(service.publish(actor,second.versionId,{...content,reviewHash:review.reviewHash,changeNote:' '}),e=>e.getStatus()===400);
      await service.updateDraft(actor,second.versionId,{template:'Concurrent edit',variables:{},expectedRevision:1});
      await assert.rejects(service.publish(actor,second.versionId,{...content,reviewHash:review.reviewHash,changeNote:'Stale review'}),e=>e.getStatus()===409);
      const v=(await service.get(resource.id)).versions[0];assert.equal(v.status,'draft');assert.equal(v.template,'Concurrent edit');
    });
    await t.test('new publication leaves fixed Agent references and environments untouched',async()=>{
      const agent=(await client.query("INSERT INTO agent_resources(kind,resource_key,name) VALUES('agent','prompt_reference','Referenced Agent') RETURNING id::int")).rows[0].id;
      const av=(await client.query("INSERT INTO agent_resource_versions(resource_id,version,status,config) VALUES($1,1,'published',$2) RETURNING id::int",[agent,JSON.stringify({promptVersionId:first.versionId})])).rows[0].id;
      await client.query("INSERT INTO agent_environment_bindings(agent_id,environment,version_id) VALUES($1,'dev',$2)",[agent,av]);
      await client.query('UPDATE agent_resources SET current_version_id=$2 WHERE id=$1',[agent,av]);
      const content={template:'Second edition',variables:{},expectedRevision:2},review=await service.review(second.versionId,content);
      assert.equal(review.usage[0].agentId,agent);assert.equal(review.usage[0].isCurrent,true);assert.deepEqual(review.usage[0].environments,[]);
      await service.publish(actor,second.versionId,{...content,reviewHash:review.reviewHash,changeNote:'明确业务边界'});
      assert.equal((await client.query('SELECT config FROM agent_resource_versions WHERE id=$1',[av])).rows[0].config.promptVersionId,first.versionId);
      assert.equal((await client.query('SELECT version_id::int FROM agent_environment_bindings WHERE agent_id=$1',[agent])).rows[0].version_id,av);
      assert.equal((await client.query('SELECT current_version_id::int FROM agent_resources WHERE id=$1',[agent])).rows[0].current_version_id,av);
      const diff=await service.diff(first.versionId,second.versionId);assert.equal(diff.left.template,'Reviewed unsaved content');assert.equal(diff.right.template,'Second edition');assert.deepEqual(diff.right.variables,{});
    });
    await t.test('invalid or unused variables cannot be published; unrelated resources cannot be compared',async()=>{
      const other=await service.create(actor,{name:'Other resource'}),v=(await service.get(other.id)).versions[0];
      await assert.rejects(service.review(v.versionId,{template:'No placeholder',variables:{unused:{type:'string',required:false}},expectedRevision:1}),e=>e.getStatus()===400&&/未用于/.test(e.message));
      await assert.rejects(service.review(v.versionId,{template:'{{missing}}',variables:{},expectedRevision:1}),e=>e.getStatus()===400);
      await assert.rejects(service.diff(first.versionId,v.versionId),e=>e.getStatus()===400);
    });
    await t.test('ordinary historical Prompt types can be selected by Agents while platform templates stay excluded',async()=>{
      const answer=await service.create(actor,{name:'Historical answer category',promptType:'answer',template:'Business guidance without variables'});
      const v=(await service.get(answer.id)).versions[0];await service.publish(actor,v.versionId);
      const agents=new AgentManagementService(database,{}, {list:()=>[]},{},{},{});
      const options=await agents.options();assert.ok(options.prompts.some(p=>p.id===v.versionId));
      assert.equal(options.prompts.some(p=>['agent.planner','agent.answer','conversation.summary'].includes(p.key)),false);
    });
  } finally {await client.query('ROLLBACK');await client.end();}
});
