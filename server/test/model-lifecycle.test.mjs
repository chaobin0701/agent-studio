import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialAccess,credentialPreview } from '../dist/model-management/credential-access.js';
import { ModelManagementService } from '../dist/model-management/model-management.service.js';
import { ModelManagementController } from '../dist/model-management/model-management.controller.js';
import { embeddingFingerprint,embeddingProfileSchema } from '../dist/documents/profile-embedding.js';
import { EmbeddingProfileService } from '../dist/documents/embedding-profile.service.js';

test('credential previews never expose short credentials and retain long-key identifiers',()=>{
  assert.equal(credentialPreview('abcd1234'),'••••••••');
  assert.equal(credentialPreview('1234567890'),'••••••90');
  assert.equal(credentialPreview('abcdefghijklmnop'),'abcd••••••mnop');
});
test('credential grants are bounded to actor/workspace/resource/key revision and expiry',t=>{
  let now=1000;t.mock.method(Date,'now',()=>now);
  const access=new CredentialAccess();
  const {token}=access.grant('1:8:llm:5:1');
  access.verify(token,'1:8:llm:5:1');
  for(const scope of ['2:8:llm:5:1','1:9:llm:5:1','1:8:embedding:5:1','1:8:llm:6:1','1:8:llm:5:2'])
    assert.throws(()=>access.verify(token,scope));
  now+=300001;assert.throws(()=>access.verify(token,'1:8:llm:5:1'));
  for(let i=0;i<5;i++)access.failed('admin:8');
  assert.throws(()=>access.checkAttempts('admin:8'));
  now+=600001;access.checkAttempts('admin:8');
});
test('model management permission alone cannot reveal credentials',()=>{
  const controller=new ModelManagementController({revealCredential:()=>{throw Error('must not execute');}});
  assert.throws(()=>controller.revealCredential({admin:{id:1},workspacePermissionCodes:['model_profiles.manage']},'llm',1,{}),e=>e.getStatus()===403);
});
test('failed combined test never publishes, successful test passes the original revision',async()=>{
  const service=new ModelManagementService({}, {}, {});
  service.version=async()=>({status:'draft',revision:6});
  let published=0;service.publish=async(_actor,_kind,_id,revision)=>{published++;assert.equal(revision,6);};
  service.testVersion=async()=>({ok:false,deployments:[]});
  assert.equal((await service.testAndPublish(1,'llm',3)).published,false);assert.equal(published,0);
  service.testVersion=async()=>({ok:true,deployments:[]});
  assert.equal((await service.testAndPublish(1,'llm',3)).published,true);assert.equal(published,1);
});
test('removal blocks current references and archives historical-only dependencies without erasing keys',async()=>{
  const statements=[];
  const service=new ModelManagementService({transaction:work=>work({query:async(sql,args)=>{statements.push(sql);return {rows:[{id:4}],rowCount:1};}})}, {}, {});
  service.references=async()=>[{type:'knowledge',id:2,name:'historical',usage:'current'}];
  await assert.rejects(service.remove(1,'embedding','accounts',4),e=>e.getStatus()===409);
  assert.ok(!statements.some(sql=>sql.startsWith('UPDATE')));
  service.references=async()=>[{type:'knowledge',id:2,name:'historical',usage:'historical'}];
  assert.equal((await service.remove(1,'embedding','accounts',4)).archived,true);
  assert.ok(statements.some(sql=>sql.includes('SET archived_at=now()')));
  assert.ok(!statements.some(sql=>/DELETE FROM|api_key_ciphertext/.test(sql)));
  service.references=async()=>[];
  assert.equal((await service.remove(1,'embedding','accounts',4)).archived,false);
  assert.ok(statements.some(sql=>sql.includes('SET deleted_at=now()')));
});

test('default selection is detachable and removal updates only the current workspace cache after commit',async()=>{
 const statements=[];
 const db={transaction:work=>work({query:async(sql,args)=>{statements.push({sql,args});return {rows:[{id:4}],rowCount:1};}})};
 const service=new ModelManagementService(db,{},{});
 service.workspacePlans.set(1,{id:2});service.workspacePlans.set(2,{id:9});
 service.references=async()=>[{type:'binding',id:2,name:'old default',usage:'automatic'},{type:'agent',id:3,name:'removed agent',usage:'historical'}];
 const result=await service.remove(1,'llm','plans',4);
 assert.equal(result.defaultCleared,true);assert.equal(result.archived,true);
 assert.ok(statements.some(s=>s.sql.startsWith('DELETE FROM model_bindings')&&s.args[0][0]===2));
 assert.equal(service.currentPlan,null);assert.equal(service.workspacePlans.get(2).id,9);
 service.workspacePlans.set(1,{id:2});
 db.transaction=async()=>{throw Error('rolled back')};
 await assert.rejects(service.remove(1,'llm','plans',4),/rolled back/);
 assert.equal(service.currentPlan.id,2);
});

test('clearing a default never reinstalls environment models when any prior library account exists',async()=>{
 const statements=[];
 const db={query:async()=>({rows:[]}),transaction:work=>work({query:async(sql)=>{statements.push(sql);return {rows:[],rowCount:sql.includes('FROM model_accounts')?1:0};}})};
 const service=new ModelManagementService(db,{get llm(){throw Error('must not import again')}},{});
 await service.onModuleInit();
 assert.ok(statements.some(sql=>sql.includes('FROM model_accounts')));
 assert.ok(!statements.some(sql=>/INSERT INTO/.test(sql)));
});

test('PostgreSQL: automatic drafts, publication pointer, protected deletion, restoration and audited credential access', {skip:process.env.KB_INTEGRATION!=='1'},async t=>{
  const {Client}=await import('pg');
  const {readFile,readdir}=await import('node:fs/promises');
  const {randomUUID}=await import('node:crypto');
  const {hash}=await import('bcryptjs');
  const {SecretBox}=await import('../dist/security/secret-box.js');
  const client=new Client({host:process.env.POSTGRES_HOST??'127.0.0.1',port:Number(process.env.POSTGRES_PORT??5433),user:process.env.POSTGRES_USER??'grounded',password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB??'agent_studio'});
  await client.connect();
  try {
    await client.query('BEGIN');
    const schema='model_lifecycle_'+randomUUID().replaceAll('-','');
    await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET LOCAL search_path TO "${schema}",public`);
    const directory=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(directory)).filter(name=>name.endsWith('.sql')).sort())await client.query((await readFile(new URL(file,directory),'utf8')).split('-- Down Migration')[0]);
    const actor=Number((await client.query("INSERT INTO admins(email,password_hash,display_name) VALUES('lifecycle@example.invalid',$1,'lifecycle') RETURNING id",[await hash('verification-only',4)])).rows[0].id);
    const database={query:(sql,args)=>client.query(sql,args),platformQuery:(sql,args)=>client.query(sql,args),transaction:async work=>{
      await client.query('SAVEPOINT operation');try{const result=await work(client);await client.query('RELEASE SAVEPOINT operation');return result;}catch(e){await client.query('ROLLBACK TO SAVEPOINT operation');throw e;}
    }};
    const baseUrl='https://provider.example.invalid/v1';
    const runtime={llm:{allowedBaseUrls:[baseUrl],baseUrl},embedding:{allowedBaseUrls:[baseUrl],baseUrl},jwt:{secret:'fixture-encryption-only'}};
    const service=new ModelManagementService(database,runtime,new SecretBox(runtime));
    t.mock.method(globalThis,'fetch',async(_url,options)=>{
      const body=JSON.parse(options.body);
      if(body.input)return Response.json({data:[{index:0,embedding:[1,0]}]});
      if(body.stream)return new Response('data: {"choices":[{"delta":{"content":"连接成功"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return Response.json({choices:[{message:body.tools?{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'connection_probe',arguments:'{"probe":"connection-test"}'}}]}:{role:'assistant',content:'{"message":"连接成功"}'},finish_reason:body.tools?'tool_calls':'stop'}]});
    });
    const account=await service.createAccount(actor,'llm',{name:'account',platformKey:'custom',baseUrl,apiKey:'fixture-secret-first-last'});
    const deployment=await service.saveDeployment(actor,'llm',null,{name:'deployment',accountId:account.id,config:{model:'primary'}});
    const plan=await service.createPlan(actor,'llm',{name:'plan',deploymentIds:[deployment.id]});
    const first=await service.version(database,'llm',plan.id);
    assert.equal((await service.testAndPublish(actor,'llm',first.id)).published,true);
    assert.equal((await service.list('llm')).plans[0].current_version_id,first.id);
    const working=await service.workingDraft(actor,'llm',first.plan_id,{});
    assert.equal(working.reused,false);
    assert.equal((await service.workingDraft(actor,'llm',first.plan_id,{})).versionId,working.versionId);
    await service.saveDeployment(actor,'llm',deployment.id,{name:'deployment',accountId:account.id,config:{model:'replacement'}});
    await assert.rejects(service.savePlanDraft(actor,'llm',first.plan_id,{name:'stale editor',sourceVersionId:first.id,revision:first.revision,deploymentIds:[deployment.id]}),e=>e.getStatus()===409);
    const unchanged=await service.savePlanDraft(actor,'llm',first.plan_id,{name:'renamed',sourceVersionId:working.versionId,revision:1,deploymentIds:[deployment.id],refreshDeployments:false});
    assert.equal(unchanged.config.deployments[0].config.model,'primary','autosave must not silently replace a deployment snapshot');
    const next=await service.savePlanDraft(actor,'llm',first.plan_id,{name:'updated',sourceVersionId:working.versionId,revision:unchanged.revision,deploymentIds:[deployment.id],refreshDeployments:true});
    assert.equal(next.version,2);assert.equal(next.config.deployments[0].config.model,'replacement');
    assert.equal((await service.version(database,'llm',first.id)).config.deployments[0].config.model,'primary');
    assert.equal((await service.testAndPublish(actor,'llm',next.id)).published,true);
    assert.equal((await service.list('llm')).plans[0].current_version_id,next.id);
    await assert.rejects(service.rollbackPlan(actor,'llm',first.plan_id,{versionId:first.id,expectedCurrentVersionId:first.id}),e=>e.getStatus()===409);
    await service.rollbackPlan(actor,'llm',first.plan_id,{versionId:first.id,expectedCurrentVersionId:next.id});
    assert.equal((await service.list('llm')).plans[0].current_version_id,first.id);
    await service.rollbackPlan(actor,'llm',first.plan_id,{versionId:next.id,expectedCurrentVersionId:first.id});
    const historyDraft=await service.workingDraft(actor,'llm',first.plan_id,{fromVersionId:first.id,branch:true});
    assert.equal((await service.version(database,'llm',historyDraft.versionId)).config.deployments[0].config.model,'primary');
    await assert.rejects(service.rollbackPlan(actor,'llm',first.plan_id,{versionId:historyDraft.versionId,expectedCurrentVersionId:next.id}),e=>e.getStatus()===400);
    await assert.rejects(service.remove(actor,'llm','accounts',account.id),e=>e.getStatus()===409);
    await assert.rejects(service.remove(actor,'llm','deployments',deployment.id),e=>e.getStatus()===409);
    const view=(await service.list('llm')).accounts[0];assert.equal(view.apiKeyPreview,'fixt••••••last');assert.ok(!JSON.stringify(view).includes('fixture-secret-first-last'));
    await assert.rejects(service.unlockCredential(actor,'llm',account.id,{password:'wrong'}),e=>e.getStatus()===400);
    const grant=await service.unlockCredential(actor,'llm',account.id,{password:'verification-only'});
    assert.equal((await service.revealCredential(actor,'llm',account.id,{token:grant.token,action:'copy'})).apiKey,'fixture-secret-first-last');
    await service.updateAccount(actor,'llm',account.id,{apiKey:'rotated-fixture-secret'});
    await assert.rejects(service.revealCredential(actor,'llm',account.id,{token:grant.token,action:'view'}),e=>e.getStatus()===403);
    assert.equal((await service.remove(actor,'llm','plans',first.plan_id)).archived,false);
    assert.equal((await service.list('llm')).plans.length,0);
    assert.equal((await service.list('llm',true)).plans.length,1);
    assert.equal((await service.remove(actor,'llm','deployments',deployment.id)).archived,true);
    assert.equal((await service.remove(actor,'llm','accounts',account.id)).archived,true);
    await service.restore(actor,'llm','accounts',account.id);await service.restore(actor,'llm','deployments',deployment.id);await service.restore(actor,'llm','plans',first.plan_id);
    assert.equal((await service.list('llm')).plans.length,1);
    const vectorAccount=await service.createAccount(actor,'embedding',{name:'vector account',platformKey:'custom',baseUrl,apiKey:'vector-fixture-key'});
    const vectorDeployment=await service.saveDeployment(actor,'embedding',null,{name:'vector',accountId:vectorAccount.id,config:{provider:'openai-compatible',model:'vectors',dimensions:2}});
    const vectorPlan=await service.createPlan(actor,'embedding',{name:'vector plan',deploymentIds:[vectorDeployment.id]});
    // Migration can retain a disabled profile and its KB reference while resetting the plan to draft.
    const importedConfig=embeddingProfileSchema.parse({provider:'openai-compatible',baseUrl,model:'vectors',dimensions:2});
    const importedProfile=(await client.query(`INSERT INTO embedding_profiles(name,platform_key,config,enabled,model_account_id,model_plan_version_id)
      VALUES('imported vector profile','custom',$1,false,$2,$3) RETURNING id::int`,[JSON.stringify(importedConfig),vectorAccount.id,vectorPlan.id])).rows[0];
    const importedSnapshot={...importedConfig,profileId:importedProfile.id,fingerprint:embeddingFingerprint(importedConfig)};
    await client.query('UPDATE embedding_profiles SET config=$2 WHERE id=$1',[importedProfile.id,JSON.stringify(importedSnapshot)]);
    const linkedBase=(await client.query("INSERT INTO knowledge_bases(name,draft_config) VALUES('imported knowledge',$1) RETURNING id::int",[JSON.stringify({embeddingProfileId:importedProfile.id})])).rows[0];
    const embeddingProfiles=new EmbeddingProfileService(database,runtime,new SecretBox(runtime));
    assert.ok(!(await embeddingProfiles.choices(true)).some(p=>p.id===importedProfile.id));
    assert.equal((await service.testAndPublish(actor,'embedding',vectorPlan.id)).published,true);
    const publishedProfiles=(await client.query('SELECT id::int,config,enabled FROM embedding_profiles WHERE model_plan_version_id=$1',[vectorPlan.id])).rows;
    assert.equal(publishedProfiles.length,1);
    assert.equal(publishedProfiles[0].id,importedProfile.id,'publishing must reuse the imported profile ID');
    assert.equal(publishedProfiles[0].enabled,true);
    assert.deepEqual(publishedProfiles[0].config,importedSnapshot);
    assert.equal((await client.query('SELECT draft_config FROM knowledge_bases WHERE id=$1',[linkedBase.id])).rows[0].draft_config.embeddingProfileId,importedProfile.id);
    assert.ok((await embeddingProfiles.choices(true)).some(p=>p.id===importedProfile.id));
    const vectorFirst=await service.version(database,'embedding',vectorPlan.id);
    const vectorDraft=await service.workingDraft(actor,'embedding',vectorFirst.plan_id,{});
    assert.equal((await service.testAndPublish(actor,'embedding',vectorDraft.versionId)).published,true);
    const conflictingDraft=await service.workingDraft(actor,'embedding',vectorFirst.plan_id,{});
    const otherAccount=await service.createAccount(actor,'embedding',{name:'other vector account',platformKey:'custom',baseUrl,apiKey:'other-vector-fixture-key'});
    const conflictingProfile=(await client.query(`INSERT INTO embedding_profiles(name,platform_key,config,enabled,model_account_id,model_plan_version_id)
      VALUES('protected vector profile','custom',$1,false,$2,$3) RETURNING id::int`,[JSON.stringify(importedConfig),vectorAccount.id,conflictingDraft.versionId])).rows[0];
    for(const conflict of [
      {config:{...importedConfig,model:'other-space'},accountId:vectorAccount.id},
      {config:{...importedConfig,dimensions:3},accountId:vectorAccount.id},
      {config:importedConfig,accountId:otherAccount.id},
    ]) {
      const snapshot={...conflict.config,profileId:conflictingProfile.id,fingerprint:embeddingFingerprint(conflict.config)};
      await client.query('UPDATE embedding_profiles SET config=$2,model_account_id=$3 WHERE id=$1',[conflictingProfile.id,JSON.stringify(snapshot),conflict.accountId]);
      await assert.rejects(service.testAndPublish(actor,'embedding',conflictingDraft.versionId),e=>e.getStatus()===409&&/向量配置/.test(e.message));
      const unchanged=(await client.query('SELECT config,enabled,model_account_id::int FROM embedding_profiles WHERE id=$1',[conflictingProfile.id])).rows[0];
      assert.deepEqual(unchanged,{config:snapshot,enabled:false,model_account_id:conflict.accountId});
      assert.equal((await service.version(database,'embedding',conflictingDraft.versionId)).status,'draft');
      assert.equal((await service.list('embedding')).plans.find(p=>p.id===vectorFirst.plan_id).current_version_id,vectorDraft.versionId);
    }
    const profilesBefore=(await client.query('SELECT id,enabled,config FROM embedding_profiles ORDER BY id')).rows;
    await service.rollbackPlan(actor,'embedding',vectorFirst.plan_id,{versionId:vectorFirst.id,expectedCurrentVersionId:vectorDraft.versionId});
    assert.equal((await service.list('embedding')).plans[0].current_version_id,vectorFirst.id);
    assert.deepEqual((await client.query('SELECT id,enabled,config FROM embedding_profiles ORDER BY id')).rows,profilesBefore);
    const audit=JSON.stringify((await client.query('SELECT * FROM audit_logs')).rows);assert.ok(audit.includes('model_credential.copy'));assert.ok(!audit.includes('fixture-secret-first-last'));assert.ok(!audit.includes(grant.token));
  }finally{await client.query('ROLLBACK');await client.end();}
});

test('removed accounts cannot be unlocked or revealed with an existing grant',async()=>{
  const service=new ModelManagementService({}, {}, {decrypt:()=>{throw Error('removed key must not be decrypted');}});
  service.account=async()=>({id:5,key_revision:1,deleted_at:new Date(),api_key_ciphertext:'encrypted'});
  service.write=async(_actor,_action,_target,work)=>work({});
  await assert.rejects(service.unlockCredential(1,'llm',5,{password:'verification-only'}),e=>e.getStatus()===400);
  await assert.rejects(service.revealCredential(1,'llm',5,{token:'a'.repeat(30),action:'copy'}),e=>e.getStatus()===400);
});
