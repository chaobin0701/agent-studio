import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { readFile,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { SecretBox } from '../dist/security/secret-box.js';
import { embeddingFingerprint,embeddingProfileSchema,embedWithProfile,EmbeddingDimensionError } from '../dist/documents/profile-embedding.js';
import { embedForProfile } from '../dist/documents/embedding-runtime.js';
import { EmbeddingProfileService } from '../dist/documents/embedding-profile.service.js';
import { EmbeddingProfileController } from '../dist/documents/embedding-profile.controller.js';
import { KnowledgeBaseController } from '../dist/documents/knowledge-base.controller.js';
import { KnowledgeBaseService } from '../dist/documents/knowledge-base.service.js';
import { KnowledgeIndexService } from '../dist/documents/knowledge-index.service.js';
import { buildKnowledgeIndex } from '../dist/documents/build-knowledge-index.js';
import { SearchService } from '../dist/documents/search.service.js';
import { VersionSearchService } from '../dist/documents/version-search.service.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';

const endpoint='https://embedding.example.invalid/v1';
const runtime={embedding:{baseUrl:endpoint,apiKey:'legacy-fixture-key',allowedBaseUrls:[endpoint],connections:{}},jwt:{secret:'fixture-test-encryption-only'}};
const secrets=new SecretBox(runtime);
const input={name:'测试配置',platformKey:'custom',provider:'openai-compatible',baseUrl:endpoint,model:'same-model',dimensions:2,maxInputChars:8000,batchSize:16,timeoutMs:30000,apiKey:'test-fixture-key'};
const profile=embeddingProfileSchema.parse(inputToConfig(input));
function inputToConfig({name,platformKey,apiKey,...config}) { return config; }

test('knowledge base model choices require published embedding plans and expose no credentials', async () => {
  const statements = [];
  const service = new EmbeddingProfileService({ query: async sql => {
    statements.push(sql);
    return { rows: [{ id: 1, name: 'Published v1', config: profile, enabled: true }] };
  } }, runtime, secrets);
  const controller = new KnowledgeBaseController(null, null, null, null, service, null, null);
  const choices = await controller.profileList();
  assert.match(statements[0], /v.status='published'/);
  assert.match(statements[0], /p.kind='embedding'/);
  assert.match(statements[0], /p.deleted_at IS NULL AND p.archived_at IS NULL/);
  assert.deepEqual(Object.keys(choices[0]).sort(), ['config', 'enabled', 'id', 'name']);
  assert.equal(Object.hasOwn(choices[0].config, 'secretRef'), false);
});

test('Embedding writes, tests and reads use independent permissions; KB choices do not expose key management',()=>{
  for(const method of ['create','update','status','remove','test']) assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY,EmbeddingProfileController.prototype[method]),['embedding_profiles.manage']);
  for(const method of ['list','metadata','usage']) assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY,EmbeddingProfileController.prototype[method]),['embedding_profiles.read','embedding_profiles.manage']);
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY,KnowledgeBaseController.prototype.profileList),['knowledge_bases.manage']);
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY,KnowledgeBaseController.prototype.profileCreate),['embedding_profiles.manage']);
});
test('vector-space signature distinguishes endpoint, provider, model and dimensions but ignores key and timeout',()=>{
  const signature=embeddingFingerprint(profile);
  for(const change of [{baseUrl:'https://other.example.invalid/v1'},{provider:'volcengine-multimodal'},{model:'other'},{dimensions:3}]) assert.notEqual(embeddingFingerprint({...profile,...change}),signature);
  assert.equal(embeddingFingerprint({...profile,baseUrl:profile.baseUrl+'/',timeoutMs:9000}),signature);
});
test('managed requests reject non-HTTP endpoints and report actual dimension, not a fabricated success',async(t)=>{
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({data:[{index:0,embedding:[1,0,0]}]}));
  await assert.rejects(embedWithProfile({...profile,baseUrl:'ftp://invalid.example/v1'},['文本'],runtime,{apiKey:'fixture'}));
  assert.equal(mock.mock.callCount(),0);
  await assert.rejects(embedWithProfile(profile,['文本'],runtime,{apiKey:'fixture'}),error=>error instanceof EmbeddingDimensionError && error.expectedDimensions===2 && error.actualDimensions===3);
});
test('standard embeddings support 1536/3072 dimensions without assuming the old live 2048 dimension',async(t)=>{
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const request=JSON.parse(options.body); const dimensions=Number(request.model);
    return Response.json({data:request.input.map((_,index)=>({index,embedding:Array(dimensions).fill(0.1)}))});
  });
  for(const dimensions of [1536,3072]) {
    const vectors=await embedWithProfile({...profile,model:String(dimensions),dimensions},['文本'],runtime,{apiKey:'fixture'});
    assert.equal(vectors[0].length,dimensions);
  }
});
test('snapshot runtime reads the latest encrypted key, checks vector identity and never uses a different endpoint key',async(t)=>{
  const managed={...profile,profileId:7,fingerprint:embeddingFingerprint(profile)};
  let current=managed,key='first-test-key';
  const database={query:async()=>({rows:[{config:current,api_key_ciphertext:secrets.encrypt(key)}]})};
  const calls=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{ calls.push(options.headers.Authorization); return Response.json({data:[{index:0,embedding:[1,0]}]}); });
  await embedForProfile(database,runtime,managed,['文本']); key='rotated-test-key';
  await embedForProfile(database,runtime,managed,['文本']);
  assert.deepEqual(calls,['Bearer first-test-key','Bearer rotated-test-key']);
  current={...managed,model:'changed'};
  await assert.rejects(embedForProfile(database,runtime,managed,['文本']),/vector space changed/);
  assert.equal(calls.length,2);
});
test('connection results expose dimension mismatch and safe errors without returning input keys or provider payloads',async(t)=>{
  const audits=[];
  const service=new EmbeddingProfileService({query:async(sql,values)=>{audits.push({sql,values});return {rows:[]};}},runtime,secrets);
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({data:[{index:0,embedding:[1,0,0]}]}));
  const mismatch=await service.test(1,input);
  assert.equal(mismatch.ok,false); assert.equal(mismatch.actualDimensions,3); assert.equal(mismatch.expectedDimensions,2);
  mock.mock.mockImplementation(async()=>new Response('sensitive-provider-payload-test',{status:401}));
  const denied=await service.test(1,input);
  assert.match(denied.message,/密钥/);
  assert.ok(!JSON.stringify([mismatch,denied,audits]).includes(input.apiKey));
  assert.ok(!JSON.stringify(denied).includes('sensitive-provider-payload-test'));
  assert.equal(audits.length,2);
});
test('new configurations require their own key, a valid API URL and a compatible adapter before writes',async()=>{
  let writes=0;
  const service=new EmbeddingProfileService({transaction:async()=>{writes++;}},runtime,secrets);
  await assert.rejects(service.create(1,{...input,apiKey:undefined}),e=>e.getStatus()===400);
  await assert.rejects(service.create(1,{...input,baseUrl:'file:///tmp/model'}),e=>e.getStatus()===400);
  await assert.rejects(service.create(1,{...input,platformKey:'openai',provider:'volcengine-multimodal'}),e=>e.getStatus()===400);
  assert.equal(writes,0);
});

test('PostgreSQL: CRUD security, mixed dimensions, preserve/build/apply, failure safety and credential rotation',{skip:process.env.KB_INTEGRATION!=='1'},async(t)=>{
  const client=new Client({host:process.env.POSTGRES_HOST??'127.0.0.1',port:Number(process.env.POSTGRES_PORT??5433),user:process.env.POSTGRES_USER??'grounded',password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB??'agent_studio'});
  const schema='embedding_test_'+randomUUID().replaceAll('-','');
  await client.connect();
  try {
    await client.query('BEGIN'); await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET LOCAL search_path TO "${schema}", public`);
    const directory=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort()) await client.query((await readFile(new URL(file,directory),'utf8')).split('-- Down Migration')[0]);
    const actor=(await client.query("INSERT INTO admins(email,password_hash,display_name) VALUES('fixture@example.invalid','not-a-password','fixture') RETURNING id")).rows[0].id;
    const database={query:(sql,values)=>client.query(sql,values),transaction:async work=>{
      await client.query('SAVEPOINT service_call');
      try { const result=await work(client); await client.query('RELEASE SAVEPOINT service_call');return result; }
      catch(error) { await client.query('ROLLBACK TO SAVEPOINT service_call');throw error; }
    }};
    const service=new EmbeddingProfileService(database,runtime,secrets);
    const bases=new KnowledgeBaseService(database);
    const queue={enqueueIndex:async()=>{}};
    const indexes=new KnowledgeIndexService(database,queue);
    const initial=await service.create(actor,input);
    assert.equal(initial.apiKeyPreview,'te***ey'); assert.equal(initial.keySource,'managed');
    assert.ok(!JSON.stringify(initial).includes(input.apiKey));
    const stored=(await client.query('SELECT api_key_ciphertext FROM embedding_profiles WHERE id=$1',[initial.id])).rows[0];
    assert.notEqual(stored.api_key_ciphertext,input.apiKey); assert.equal(secrets.decrypt(stored.api_key_ciphertext),input.apiKey);
    await assert.rejects(service.update(actor,initial.id,{platformKey:'volcengine'}),e=>e.getStatus()===400);
    await service.update(actor,initial.id,{name:'已重命名'});
    assert.equal((await service.list())[0].name,'已重命名');
    const base=await bases.create(actor,{name:'知识库测试',draftConfig:{indexMode:'high_quality',retrievalMode:'hybrid',embeddingProfileId:initial.id}});
    await assert.rejects(service.update(actor,initial.id,{dimensions:3}),e=>e.getStatus()===409);
    await assert.rejects(service.remove(actor,initial.id),e=>e.getStatus()===409);
    await assert.rejects(service.setEnabled(actor,initial.id,{enabled:false}),e=>e.getStatus()===409);
    assert.equal((await service.list())[0].usageCount,1);
    assert.equal(Object.hasOwn((await service.choices())[0],'apiKeyPreview'),false);
    const doc=(await client.query(`INSERT INTO documents(title,original_filename,storage_key,sha256,byte_size,uploaded_by,status,knowledge_base_id)
      VALUES('售后规则','test.md','fixture-test.md',repeat('a',64),1,$1,'ready',$2) RETURNING id`,[actor,base.id])).rows[0];
    await client.query(`INSERT INTO document_blocks(document_id,ordinal,block_type,heading_path,content,source_locator)
      VALUES($1,1,'paragraph','售后','申请退货需要在七天内联系售后。','{"type":"markdown_lines","start":1,"end":2}')`,[doc.id]);
    await client.query(`INSERT INTO document_chunks(document_id,ordinal,heading_path,content,source_start_line,source_end_line,embedding,embedding_model,embedding_fingerprint,embedding_profile_id)
      VALUES($1,1,'售后','申请退货需要在七天内联系售后。',1,2,'[1,0]',$2,$3,$4),($1,2,'无关','不同向量空间',3,3,'[1,0,0]',$2,'other-space',null)`,[doc.id,input.model,initial.config.fingerprint,initial.id]);
    const calls=[];
    const fetchMock=t.mock.method(globalThis,'fetch',async(_url,options)=>{
      const request=JSON.parse(options.body);calls.push(options.headers.Authorization);
      const dimensions=request.model==='new-model'?3:2;
      return Response.json({data:request.input.map((_,index)=>({index,embedding:dimensions===2?[1,0]:[1,0,0]}))});
    });
    const search=new SearchService(database,{enabled:false},undefined,runtime);
    const live=await search.recallTest(base.id,'申请退货',5,'hybrid');
    assert.equal(live.vectorIndexedChunks,1); assert.equal(live.vectorResults.length,1);
    const replacement=await service.create(actor,{...input,name:'替代配置',model:'new-model',dimensions:3,apiKey:'replacement-test-key'});
    await indexes.configure(actor,base.id,{indexMode:'high_quality',retrievalMode:'hybrid',embeddingProfileId:replacement.id});
    const frozen=(await bases.get(base.id)).activeIndexVersionId;
    assert.ok(frozen,'old live index must be frozen before changing the draft');
    const versionSearch=new VersionSearchService(database,runtime);
    assert.equal((await versionSearch.search('申请退货',5,base.id)).vectorIndexedChunks,1);
    const next=await indexes.build(actor,base.id);
    const workerPool={connect:async()=>({query:async(sql,values)=>{
      if(sql==='BEGIN') return client.query('SAVEPOINT index_build');
      if(sql==='COMMIT') return client.query('RELEASE SAVEPOINT index_build');
      if(sql==='ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT index_build');
      return client.query(sql,values);
    },release:()=>{}})};
    await buildKnowledgeIndex(workerPool,next.id,runtime);
    assert.equal((await bases.get(base.id)).activeIndexVersionId,frozen,'ready does not silently activate');
    await indexes.activate(actor,base.id,next.id);
    const active=await versionSearch.search('申请退货',5,base.id);
    assert.equal(active.vectorResults.length,1);
    await service.update(actor,replacement.id,{apiKey:'rotated-integration-key'});
    await versionSearch.search('申请退货',5,base.id);
    assert.equal(calls.at(-1),'Bearer rotated-integration-key');
    const failed=await indexes.build(actor,base.id);
    fetchMock.mock.mockImplementation(async()=>new Response('',{status:429}));
    await assert.rejects(buildKnowledgeIndex(workerPool,failed.id,runtime));
    assert.equal((await bases.get(base.id)).activeIndexVersionId,next.id,'failed build cannot replace active version');
    assert.equal((await indexes.versions(base.id))[0].status,'failed');
    const unused=await service.create(actor,{...input,name:'未使用配置'});
    await service.setEnabled(actor,unused.id,{enabled:false}); await service.remove(actor,unused.id);
    assert.ok(!(await service.list()).some(p=>p.id===unused.id));
    await assert.rejects(service.remove(actor,initial.id),e=>e.getStatus()===409,'historical version protects original config');
    const audit=(await client.query("SELECT action,details FROM audit_logs WHERE action LIKE 'embedding_profile.%' OR action='knowledge_index.preserved'")).rows;
    assert.ok(audit.some(a=>a.action==='embedding_profile.deleted')); assert.ok(audit.some(a=>a.action==='knowledge_index.preserved'));
    assert.ok(!JSON.stringify(audit).includes(input.apiKey));
  } finally { await client.query('ROLLBACK'); await client.end(); }
});
