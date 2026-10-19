import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { KnowledgeBaseService } from '../dist/documents/knowledge-base.service.js';
import { KnowledgeBaseController } from '../dist/documents/knowledge-base.controller.js';
import { DocumentService } from '../dist/documents/document.service.js';
import { SearchService } from '../dist/documents/search.service.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';
import { KnowledgeIndexService } from '../dist/documents/knowledge-index.service.js';
import { VersionSearchService } from '../dist/documents/version-search.service.js';
import { buildKnowledgeIndex } from '../dist/documents/build-knowledge-index.js';
import { prepareAutoIndex } from '../dist/documents/auto-index.js';
import { agentRetrievalSchema } from '../dist/documents/knowledge-config.js';
import { mergeKnowledgeCandidates } from '../dist/documents/version-search.service.js';

test('cross-library ranking uses ranks rather than incomparable source scores',()=>{
  const hit=(chunkId,score)=>({chunkId,documentId:chunkId,ordinal:1,score});
  const result=mergeKnowledgeCandidates([[hit(1,0.02),hit(3,0.01)],[hit(2,0.99)]],2);
  assert.deepEqual(result.map(hit=>hit.chunkId),[1,2]);
});
test('Agent knowledge context cap truncates a large source without increasing the cap',async()=>{
  const hit={chunkId:1,documentId:1,ordinal:1,documentTitle:'Policy',headingPath:'Returns',content:'x'.repeat(2400),score:1};
  const db={query:async(sql)=>({rows:sql.includes('SELECT v.id::int')?[{id:1,config:{},knowledgeBaseId:1}]:[hit]})};
  const result=await new VersionSearchService(db,{}).search('returns',5,1,1,{contextChars:1000});
  assert.ok(result.hits[0].content.length<1000);
  assert.equal(result.hits[0].contentTruncated,true);
});

test('economic-index rollback is rejected for a live explicit vector Agent',async()=>{
  const statements=[];
  const db={transaction:work=>work({query:async(sql)=>{
    statements.push(sql);
    if(sql.startsWith('SELECT id FROM knowledge_bases'))return {rows:[{id:1}]};
    if(sql.startsWith('SELECT config'))return {rows:[{config:{indexMode:'economy'}}]};
    if(sql.includes('SELECT DISTINCT r.name'))return {rows:[{name:'Vector agent'}]};
    throw Error('Unexpected write');
  }})};
  await assert.rejects(new KnowledgeIndexService(db,{}).activate(1,1,10),error=>error.getStatus()===409);
  assert.equal(statements.some(sql=>sql.startsWith('UPDATE')),false);
});

test('knowledge base writes reject invalid configuration before accessing storage', async () => {
  const bases = new KnowledgeBaseService({});
  for (const input of [{ name: ' ' }, { name: 'ok', enabledForChat: 'true' }, { name: 'ok', secret: 'invalid' }]) {
    await assert.rejects(bases.create(1, input), (error) => error.getStatus() === 400);
  }
  await assert.rejects(bases.update(1, 1, {}), (error) => error.getStatus() === 400);
});

test('document state filter is validated before storage and forwarded with pagination', async () => {
  const calls = [];
  const controller = new KnowledgeBaseController({get: async id => calls.push(['base',id])}, {list: async (...args) => {calls.push(['list', ...args]);return [];}});
  await assert.rejects(controller.listDocuments(3,21,20,false,'invalid'), e => e.getStatus() === 400);
  for (const ids of ['', '0', '9007199254740992', '1,2,a', Array.from({length:21},(_,i)=>i+1).join(',')]) await assert.rejects(controller.listDocuments(3,21,20,'false','all',ids), e => e.getStatus() === 400);
  assert.equal(calls.length,0);
  await controller.listDocuments(3,21,20,'false','archived');
  assert.deepEqual(calls,[['base',3],['list',21,20,3,false,'archived',undefined]]);
});

test('creating a knowledge base without a visibility field defaults to enabled', async () => {
  let inserted;
  const bases = new KnowledgeBaseService({ transaction: work => work({ query: async (sql, values) => {
    if (sql.includes('INSERT INTO knowledge_bases')) {
      inserted = values;
      return { rows: [{ id: 3, name: values[0], enabledForChat: values[2] }] };
    }
    return { rows: [] };
  } }) });
  const result = await bases.create(7, { name: 'New knowledge base' });
  assert.equal(inserted[2], true);
  assert.equal(result.enabledForChat, true);
});

test('editing knowledge base basic information preserves its existing enabled state', async () => {
  let updated;
  const bases = new KnowledgeBaseService({ transaction: work => work({ query: async (sql, values) => {
    if (sql.startsWith('UPDATE knowledge_bases')) {
      assert.match(sql, /enabled_for_chat = COALESCE\(\$4, enabled_for_chat\)/);
      updated = values;
      return { rows: [{ id: 3, name: values[1], enabledForChat: false }] };
    }
    return { rows: [] };
  } }) });
  const result = await bases.update(7, 3, { name: 'Renamed', description: 'Updated description' });
  assert.equal(updated[3], null);
  assert.equal(result.enabledForChat, false);
});

test('knowledge base publishing controls require management permission', () => {
  for (const method of ['create', 'update', 'archive', 'unarchive', 'processing', 'indexConfig', 'settings', 'retryIndex']) {
    assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, KnowledgeBaseController.prototype[method]), ['knowledge_bases.manage']);
  }
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, KnowledgeBaseController.prototype.upload), ['documents.upload']);
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, KnowledgeBaseController.prototype.indexChunks), ['documents.read']);
});

test('combined knowledge settings reject invalid fields before writing basic information', async () => {
  const indexes = new KnowledgeIndexService({}, {});
  const settings = { name: 'New name', description: '', processingConfig: {}, indexConfig: {} };
  for (const invalid of [
    { ...settings, name: ' ' },
    { ...settings, processingConfig: { chunkChars: 200, overlapChars: 300 } },
    { ...settings, indexConfig: { indexMode: 'high_quality' } },
    { ...settings, enabledForChat: true },
  ]) await assert.rejects(indexes.saveSettings(1, 1, invalid), error => error.getStatus() === 400);
});

test('combined knowledge settings use one update and do not change visibility or active index', async () => {
  const statements = [];
  const indexes = new KnowledgeIndexService({ transaction: work => work({ query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.startsWith('SELECT draft_config')) return { rows: [{ draft_config: {}, active_index_version_id: 10 }] };
    return { rows: [], rowCount: 1 };
  } }) }, {});
  await indexes.saveSettings(1, 3, { name: 'New name', description: 'New description', processingConfig: { chunkChars: 1000 }, indexConfig: {} });
  const updates = statements.filter(statement => statement.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].values.slice(0, 3), [3, 'New name', 'New description']);
  assert.equal(JSON.parse(updates[0].values[3]).chunkChars, 1000);
  assert.doesNotMatch(updates[0].sql, /enabled_for_chat|active_index_version_id/);
  assert.match(statements.at(-1).sql, /knowledge_base.settings_updated/);
});

test('index chunk inspection pins the active version and never falls back to current document chunks', async () => {
  const statements = [];
  const indexes = new KnowledgeIndexService({ query: async (sql, values) => {
    statements.push({ sql, values });
    // The document was uploaded after the published version: no frozen chunks.
    return { rows: statements.length === 1 ? [{ title: 'New document', originalFilename: 'new.md', versionId: 12 }] : [] };
  } }, {});
  const result = await indexes.documentChunks(3, 8);
  assert.equal(result.indexKind, 'published');
  assert.equal(result.versionId, 12);
  assert.deepEqual(result.chunks, []);
  assert.deepEqual(statements[0].values, [3, 8]);
  assert.deepEqual(statements[1].values, [3, 12, 8]);
  assert.match(statements[1].sql, /v\.status='ready'/);
  assert.equal(statements.some(({ sql }) => /FROM document_chunks/.test(sql)), false);
});

test('index chunk inspection rejects a document outside the base before reading chunks', async () => {
  let calls = 0;
  const indexes = new KnowledgeIndexService({ query: async () => { calls++; return { rows: [] }; } }, {});
  await assert.rejects(indexes.documentChunks(3, 8), error => error.getStatus() === 404);
  assert.equal(calls, 1);
});

test('bases without a published index expose their legacy chunks with an explicit live marker', async () => {
  let calls = 0;
  const chunks = [{ ordinal: 1, content: 'Live content' }];
  const indexes = new KnowledgeIndexService({ query: async () => ({ rows: ++calls === 1 ? [{ versionId: null }] : chunks }) }, {});
  const result = await indexes.documentChunks(3, 8);
  assert.equal(result.indexKind, 'live');
  assert.deepEqual(result.chunks, chunks);
});

test('default and ordinary bases archive transactionally without deleting documents or changing defaults', async () => {
  for (const isDefault of [true, false]) {
    const statements = [];
    const bases = new KnowledgeBaseService({ transaction: work => work({ query: async (sql, values) => {
      statements.push({ sql, values });
      return { rows: sql.startsWith('SELECT') ? [{ id: 3, is_default: isDefault }] : [], rowCount: 1 };
    } }) });
    assert.deepEqual(await bases.archive(7, 3), { id: 3, archived: true });
    assert.match(statements[0].sql, /archived_at IS NULL FOR UPDATE/);
    assert.match(statements[1].sql, /archived_at = now\(\), enabled_for_chat = false/);
    assert.deepEqual(statements[1].values, [3]);
    assert.match(statements[2].sql, /knowledge_base\.archived/);
    assert.deepEqual(statements[2].values, [7, '3']);
    assert.ok(statements.every(({ sql }) => !/DELETE|SET is_default|UPDATE documents|UPDATE knowledge_index_versions/.test(sql)));
  }
});

test('nonexistent or already archived bases never produce writes or audit entries', async () => {
  const statements = [];
  const bases = new KnowledgeBaseService({ transaction: work => work({ query: async sql => {
    statements.push(sql); return { rows: [] };
  } }) });
  await assert.rejects(bases.archive(7, 3), error => error.getStatus() === 404);
  assert.equal(statements.length, 1);
});

test('restoring a knowledge base preserves content and indexes and requires a separate enable action', async () => {
  const statements = [];
  const service = new KnowledgeBaseService({ transaction: work => work({ query: async (sql, values) => {
    statements.push({ sql, values });
    return { rows: sql.startsWith('UPDATE') ? [{ id: 3 }] : [] };
  } }) });
  assert.deepEqual(await service.unarchive(7, 3), { id: 3, archived: false });
  assert.match(statements[0].sql, /archived_at=NULL,enabled_for_chat=false/);
  assert.match(statements[0].sql, /archived_at IS NOT NULL/);
  assert.ok(statements.every(({ sql }) => !/DELETE|UPDATE documents|active_index_version_id/.test(sql)));
  assert.match(statements[1].sql, /knowledge_base.unarchived/);
  assert.deepEqual(statements[1].values, [7, '3']);
  const missing = new KnowledgeBaseService({ transaction: work => work({ query: async () => ({ rows: [] }) }) });
  await assert.rejects(missing.unarchive(7, 3), error => error.getStatus() === 404);
});

test('legacy diagnostic lookup does not choose an archived default published index', async () => {
  const statements = [];
  const search = new SearchService({ query: async sql => { statements.push(sql); return { rows: [] }; } }, { enabled: false }, {
    search: async () => { throw new Error('Archived default must not enter version search'); },
  });
  assert.deepEqual((await search.diagnose('保修期限', 5, undefined)).results, []);
  assert.match(statements[0], /is_default AND archived_at IS NULL/);
});

test('knowledge base recall test searches only ready, active documents in the selected base', async () => {
  const statements = [];
  const database = { query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.includes('SELECT draft_config,retrieval_config FROM knowledge_bases')) return { rows: [{ draft_config: {} }] };
    return { rows: [{ chunkId: 41, documentId: 8, documentTitle: '售后政策', originalFilename: 'returns.md',
      ordinal: 1, headingPath: '退货', content: '商品签收后七天内可申请退货。', sourceStartLine: 1, sourceEndLine: 1, score: 0.9 }] };
  } };
  const result = await new SearchService(database, { enabled: false }).recallTest(6, '退货期限', 5, 'fulltext');
  assert.equal(result.hits[0].documentId, 8);
  assert.equal(result.hits[0].matchType, '全文');
  assert.match(statements[1].sql, /d\.knowledge_base_id=\$2/);
  assert.deepEqual(statements[1].values.slice(0, 3), ['退货期限', 6, 0.15]);
  await assert.rejects(new SearchService(database, { enabled: false }).recallTest(6, 'x', 5), (error) => error.getStatus() === 400);
});

test('publishing a ready version switches the index and enables visitor QA in one update', async () => {
  const statements = [];
  const database = {
    transaction: (work) => work({ query: async (sql, values) => {
      statements.push({ sql, values });
      if (sql.includes('SELECT id FROM knowledge_bases')) return {rows:[{retrieval_config:{topK:2}}]};
      if (sql.includes('SELECT config')) return {rows:[{config:{}}]};
      return sql.includes('UPDATE knowledge_bases') ? { rowCount: 1 } : { rows: [], rowCount: 1 };
    } }),
  };
  const indexes = new KnowledgeIndexService(database, {});
  assert.deepEqual(await indexes.activate(7, 3, 12), { id: 3, activeIndexVersionId: 12 });
  const switchQuery = statements.find(statement => statement.sql.includes('active_index_version_id=v.id'));
  assert.match(switchQuery.sql, /active_index_version_id=v\.id, enabled_for_chat=true/);
  assert.deepEqual(switchQuery.values, [3, 12]);
});

// Opt-in integration test: runs migrations in a random schema inside a rolled-back
// transaction. Existing application tables and files are never modified.
test('PostgreSQL migration, document scope and chat visibility remain isolated', { skip: process.env.KB_INTEGRATION !== '1' }, async (t) => {
  const client = new Client({
    host: process.env.POSTGRES_HOST ?? 'localhost', port: Number(process.env.POSTGRES_PORT ?? 5433),
    user: process.env.POSTGRES_USER ?? 'grounded', password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB ?? 'agent_studio',
  });
  const schema = `kb_test_${randomUUID().replaceAll('-', '')}`;
  const uploadRoot = await mkdtemp(join(tmpdir(), 'grounded-kb-test-'));
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      if (file.startsWith('0012')) break;
      await client.query((await readFile(new URL(file, directory), 'utf8')).split('-- Down Migration')[0]);
    }
    const actor = (await client.query(`INSERT INTO admins (email, password_hash, display_name)
      VALUES ('fixture@example.invalid', 'not-a-password', 'fixture') RETURNING id`)).rows[0].id;
    await client.query(`INSERT INTO documents (title, original_filename, storage_key, sha256, byte_size, uploaded_by, status)
      VALUES ('原有资料', 'old.md', 'old.md', repeat('a', 64), 1, $1, 'ready')`, [actor]);
    await client.query(await readFile(new URL('0012_knowledge_bases.sql', directory), 'utf8'));
    let convertedDocumentId;
    for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql') && name > '0012_knowledge_bases.sql').sort()) {
      if (file.startsWith('0043')) {
        convertedDocumentId = (await client.query("INSERT INTO documents(knowledge_base_id,title,original_filename,storage_key,sha256,byte_size,uploaded_by,status,source_type) VALUES((SELECT id FROM knowledge_bases WHERE is_default),'旧问答','FAQ','legacy.faq',repeat('a',64),1,$1,'ready','faq') RETURNING id::int",[actor])).rows[0].id;
        await client.query("INSERT INTO faq_entries(document_id,question,answer,category,source) VALUES($1,'如何退款','联系客服办理退款','售后','服务手册')",[convertedDocumentId]);
        await client.query("INSERT INTO document_blocks(document_id,ordinal,block_type,heading_path,content,source_locator) VALUES($1,1,'faq','如何退款','联系客服办理退款','{\"type\":\"faq_entry\",\"start\":1,\"end\":1}')",[convertedDocumentId]);
      }
      await client.query((await readFile(new URL(file, directory), 'utf8')).split('-- Down Migration')[0]);
    }
    const database = {
      query: (sql, values) => client.query(sql, values),
      transaction: async (work) => {
        await client.query('SAVEPOINT service_call');
        try { const result = await work(client); await client.query('RELEASE SAVEPOINT service_call'); return result; }
        catch (error) { await client.query('ROLLBACK TO SAVEPOINT service_call'); throw error; }
      },
    };
    const bases = new KnowledgeBaseService(database);
    let autoQueued=0;
    const documents = new DocumentService(database, { enqueue: async () => {},enqueueAuto:async()=>{autoQueued++;} }, { uploadRoot });
    const migrated = (await client.query('SELECT * FROM documents WHERE id=$1',[convertedDocumentId])).rows[0];
    assert.equal(migrated.source_type,'file');
    assert.match(migrated.original_filename,/\.md$/);
    const download = await documents.download(convertedDocumentId,migrated.knowledge_base_id);
    const downloadParts = [];
    for await (const part of download.getStream()) downloadParts.push(part);
    assert.match(Buffer.concat(downloadParts).toString(),/联系客服办理退款/);
    assert.equal((await client.query('SELECT block_type FROM document_blocks WHERE document_id=$1',[convertedDocumentId])).rows[0].block_type,'paragraph');
    // Keep subsequent default-base scope assertions independent of migration data.
    await documents.archive(actor,convertedDocumentId,migrated.knowledge_base_id);
    const search = new SearchService(database, { enabled: false });
    const defaultBase = (await bases.list())[0];
    const second = await bases.create(actor, { name: '内部草稿' });
    assert.equal(second.enabledForChat, true, 'a new knowledge base is active without a publish step');
    assert.equal((await documents.list(50, 0)).filter(d=>!d.archivedAt).length, 1);
    const file = { originalname: 'fixture.md', buffer: Buffer.from('隔离资料'), size: Buffer.byteLength('隔离资料') };
    const uploaded = await documents.upload(actor, file, '新资料', second.id);
    assert.equal((await documents.list(50, 0, second.id)).length, 1);
    assert.equal((await documents.list(50, 0)).filter(d=>!d.archivedAt).length, 1);
    for (const action of [() => documents.get(uploaded.id), () => documents.listChunks(uploaded.id),
      () => documents.archive(actor, uploaded.id, defaultBase.id), () => documents.reprocess(actor, uploaded.id, defaultBase.id)]) {
      await assert.rejects(action(), (error) => error.getStatus() === 404);
    }
    await client.query("UPDATE documents SET status = 'ready' WHERE id = $1", [uploaded.id]);
    await client.query(`INSERT INTO document_chunks (document_id, ordinal, content, source_start_line, source_end_line)
      VALUES ($1, 1, '隔离资料', 1, 1)`, [uploaded.id]);
    await bases.update(actor, second.id, { enabledForChat: false });
    assert.equal((await search.searchForAgent('隔离资料')).hits.length, 0);
    await bases.update(actor, second.id, { name: '已更名', enabledForChat: true });
    assert.equal((await bases.get(second.id)).enabledForChat, true);
    assert.equal((await search.searchForAgent('隔离资料')).hits.length, 1, 'ready documents enter chat retrieval automatically');
    assert.equal((await search.diagnose('隔离资料', 5, undefined)).results.length, 0);
    const documentBase = await bases.create(actor, { name: 'Versioned documents' });
    const content = '# Returns\n\n七天内联系客服申请退货。';
    const indexedDocument = await documents.upload(actor,{originalname:'returns.md',buffer:Buffer.from(content),size:Buffer.byteLength(content)},'Returns',documentBase.id);
    await client.query("UPDATE documents SET status='ready' WHERE id=$1",[indexedDocument.id]);
    await client.query("INSERT INTO document_blocks(document_id,ordinal,block_type,heading_path,content,source_locator) VALUES($1,1,'paragraph',$2,$3,$4)", [indexedDocument.id,'如何申请退货','七天内联系客服申请退货。',JSON.stringify({type:'markdown_lines',start:1,end:3})]);
    const indexes = new KnowledgeIndexService(database, { enqueueIndex: async () => {} });
    await indexes.configure(actor,documentBase.id,{});
    const first = await indexes.build(actor,documentBase.id);
    await assert.rejects(indexes.build(actor,documentBase.id), (error) => error.getStatus()===409);
    const workerPool = { connect: async () => ({
      query: (sql, values) => client.query(sql==='BEGIN' ? 'SAVEPOINT worker_call' : sql==='COMMIT' ? 'RELEASE SAVEPOINT worker_call' : sql==='ROLLBACK' ? 'ROLLBACK TO SAVEPOINT worker_call' : sql,values),
      release() {},
    }) };
    // Economy must not access configuration or a remote provider at all.
    const runtime = { get embedding() { throw new Error('Economy called embedding'); } };
    await buildKnowledgeIndex(workerPool,first.id,runtime);
    const versionSearch = new VersionSearchService(database,runtime);
    assert.equal((await versionSearch.search('申请退货',5,documentBase.id)).hits.length,0);
    await indexes.activate(actor,documentBase.id,first.id);
    const inspected = await indexes.documentChunks(documentBase.id, indexedDocument.id);
    assert.equal(inspected.indexKind, 'published');
    assert.equal(inspected.versionId, first.id);
    assert.equal(inspected.chunks[0].kind, 'general');
    assert.match(inspected.chunks[0].content, /七天/);
    await assert.rejects(indexes.documentChunks(second.id, indexedDocument.id), error => error.getStatus() === 404);
    assert.equal((await bases.get(documentBase.id)).enabledForChat, true, 'publishing the first ready index also enables visitor QA');
    const found = await versionSearch.search('申请退货',5,documentBase.id);
    assert.equal(found.hits.length,1);
    assert.equal(found.hits[0].documentId,indexedDocument.id);
    assert.equal(found.hits[0].sourceLocator.type, 'markdown_lines');
    assert.equal(found.embeddingCalls,0);
    const originalIndex = (await client.query('SELECT config,input_snapshot FROM knowledge_index_versions WHERE id=$1',[first.id])).rows[0];
    const versionCount = (await indexes.versions(documentBase.id)).length;
    await t.test('settings dialog saves atomically without rebuilding or changing active capabilities', async () => {
      const before = await bases.get(documentBase.id);
      const body = { name: 'Versioned documents settings', description: 'Combined settings', processingConfig: { ...before.processingConfig, chunkChars: 1000 }, indexConfig: before.indexConfig };
      await indexes.saveSettings(actor, documentBase.id, body);
      const after = await bases.get(documentBase.id);
      assert.equal(after.name, body.name);
      assert.equal(after.processingConfig.chunkChars, 1000);
      assert.equal(after.activeIndexVersionId, before.activeIndexVersionId);
      assert.deepEqual(after.activeIndexConfig, before.activeIndexConfig);
      assert.equal((await indexes.versions(documentBase.id)).length, versionCount);
      const invalidProfile = { ...body, name: 'Must not be saved', indexConfig: { indexMode: 'high_quality', embeddingProfileId: 2147483647 } };
      await assert.rejects(indexes.saveSettings(actor, documentBase.id, invalidProfile), error => error.getStatus() === 400);
      assert.equal((await bases.get(documentBase.id)).name, body.name);
      await indexes.saveSettings(actor, documentBase.id, { name: before.name, description: before.description, processingConfig: before.processingConfig, indexConfig: before.indexConfig });
    });
    const retuned = await versionSearch.search('申请退货',5,documentBase.id,first.id,{retrievalMode:'fulltext',topK:1,lexicalThreshold:0.8});
    assert.equal(retuned.retrievalConfigs[0].config.topK,1);
    assert.deepEqual((await client.query('SELECT config,input_snapshot FROM knowledge_index_versions WHERE id=$1',[first.id])).rows[0],originalIndex);
    assert.equal((await indexes.versions(documentBase.id)).length,versionCount);
    await assert.rejects(indexes.configureSection(actor,documentBase.id,'retrieval',{}),error=>error.getStatus()===400);
    assert.match(found.hits[0].content,/七天/);
    await client.query('UPDATE document_blocks SET content=$2 WHERE document_id=$1',[indexedDocument.id,'十四天内联系客服申请退货。']);
    assert.match((await indexes.documentChunks(documentBase.id, indexedDocument.id)).chunks[0].content, /七天/);
    assert.match((await versionSearch.search('申请退货',5,documentBase.id)).hits[0].content,/七天/);
    const secondVersion = await indexes.build(actor,documentBase.id);
    await buildKnowledgeIndex(workerPool,secondVersion.id,runtime);
    await buildKnowledgeIndex(workerPool,secondVersion.id,runtime);
    await indexes.activate(actor,documentBase.id,secondVersion.id);
    assert.match((await versionSearch.search('申请退货',5,documentBase.id)).hits[0].content,/十四天/);
    await indexes.activate(actor,documentBase.id,first.id);
    assert.match((await versionSearch.search('申请退货',5,documentBase.id)).hits[0].content,/七天/);
    assert.match((await new SearchService(database,{enabled:false},versionSearch).searchForAgent('申请退货')).hits[0].content,/七天/);
    const embeddingRuntime = { embedding:{baseUrl:'https://embedding.example.invalid/v1',apiKey:'fake-key',connections:{}} };
    const embeddingSearch = new VersionSearchService(database,embeddingRuntime);
    const fetchMock=t.mock.method(globalThis,'fetch',async(_url,options)=>{
      const request=JSON.parse(options.body);
      const vector=request.model==='two-dimensional'?[1,0]:[1,0,0];
      return Response.json({data:request.input.map((_,index)=>({index,embedding:vector}))});
    });
    for(const dimensions of [2,3]) {
      const config={provider:'openai-compatible',baseUrl:embeddingRuntime.embedding.baseUrl,
        model:dimensions===2?'two-dimensional':'three-dimensional',dimensions,maxInputChars:8000,batchSize:16,secretRef:'default'};
      const profile=(await client.query("INSERT INTO embedding_profiles(name,config) VALUES('fixture',$1) RETURNING id::int",[config])).rows[0];
      await indexes.configure(actor,documentBase.id,{indexMode:'high_quality',retrievalMode:'hybrid',embeddingProfileId:profile.id});
      const next=await indexes.build(actor,documentBase.id);
      await buildKnowledgeIndex(workerPool,next.id,embeddingRuntime);
      const unpublished=await embeddingSearch.search('申请退货',5,documentBase.id,next.id,{retrievalMode:'hybrid',topK:5,lexicalThreshold:0.15,vectorThreshold:0.65});
      assert.equal(unpublished.vectorResults.length,1);
      assert.equal(unpublished.embeddingCalls,1);
      assert.equal(unpublished.hits[0].vectorRank,1);
      assert.equal(unpublished.hits[0].lexicalRank,1);
      await indexes.activate(actor,documentBase.id,next.id);
      assert.equal((await embeddingSearch.search('申请退货',5,documentBase.id,next.id,{retrievalMode:'vector',topK:1,vectorThreshold:0.9})).embeddingCalls,1);
      const pinned = await embeddingSearch.search('申请退货',5,documentBase.id,next.id,{retrievalMode:'fulltext',topK:2});
      assert.equal(pinned.embeddingCalls,0);
      await indexes.activate(actor,documentBase.id,first.id);
    }
    fetchMock.mock.mockImplementation(async()=>new Response('',{status:429}));
    const broken=await indexes.build(actor,documentBase.id);
    await assert.rejects(buildKnowledgeIndex(workerPool,broken.id,embeddingRuntime));
    assert.equal((await client.query('SELECT status FROM knowledge_index_versions WHERE id=$1',[broken.id])).rows[0].status,'failed');
    assert.equal((await bases.get(documentBase.id)).activeIndexVersionId,first.id);
    assert.match((await versionSearch.search('申请退货',5,documentBase.id)).hits[0].content,/七天/);
    await assert.rejects(indexes.activate(actor,documentBase.id,broken.id),(error)=>error.getStatus()===409);
    await assert.rejects(indexes.activate(actor,second.id,first.id),(error)=>error.getStatus()===409);
    await documents.archive(actor,indexedDocument.id,documentBase.id);
    assert.equal((await versionSearch.search('申请退货',5,documentBase.id)).hits.length,0);
    await indexes.activate(actor,documentBase.id,secondVersion.id);
    assert.equal((await versionSearch.search('申请退货',5,documentBase.id)).hits.length,0,'rollback must not bypass archival');
    await documents.unarchive(actor,indexedDocument.id,documentBase.id);
    assert.equal((await versionSearch.search('申请退货',5,documentBase.id)).hits.length,1,'restore uses existing frozen chunks without rebuilding');
    await documents.setEnabled(actor,indexedDocument.id,false,documentBase.id);
    assert.equal((await versionSearch.search('申请退货',5,documentBase.id)).hits.length,0);
    const tuningBase = await bases.create(actor,{name:'Retrieval tuning'});
    for (const title of ['政策甲','政策乙']) {
      const text = '商品签收后七天内可以申请退货。';
      const doc = await documents.upload(actor,{originalname:`${title}.md`,buffer:Buffer.from(text),size:Buffer.byteLength(text)},title,tuningBase.id);
      await client.query("UPDATE documents SET status='ready' WHERE id=$1",[doc.id]);
      await client.query("INSERT INTO document_blocks(document_id,ordinal,block_type,heading_path,content,source_locator) VALUES($1,1,'paragraph','退货政策',$2,'{\"type\":\"markdown_lines\",\"start\":1,\"end\":1}')",[doc.id,text]);
    }
    await indexes.configureSection(actor,tuningBase.id,'processing',{chunkChars:1200});
    const tuningIndex = await indexes.build(actor,tuningBase.id);
    const frozenInput = (await client.query('SELECT input_snapshot FROM knowledge_index_versions WHERE id=$1',[tuningIndex.id])).rows[0].input_snapshot;
    assert.equal(frozenInput[0].processingConfig.chunkChars,800,'existing documents retain their upload-time rules');
    await buildKnowledgeIndex(workerPool,tuningIndex.id,runtime);
    await indexes.activate(actor,tuningBase.id,tuningIndex.id);
    assert.equal((await versionSearch.search('申请退货',8,tuningBase.id,tuningIndex.id,{topK:1})).hits.length,1);
    assert.equal((await versionSearch.search('申请退货',8,tuningBase.id,tuningIndex.id,{topK:2})).hits.length,2);
    assert.equal((await versionSearch.search('退货申请流程',8,tuningBase.id,tuningIndex.id,{topK:2,lexicalThreshold:0})).hits.length,2);
    assert.equal((await versionSearch.search('退货申请流程',8,tuningBase.id,tuningIndex.id,{topK:2,lexicalThreshold:1})).hits.length,0);
    assert.equal((await indexes.versions(tuningBase.id)).length,1,'retuning never creates new index versions');
    assert.equal((await documents.reprocessAll(actor,tuningBase.id)).queued,2);
    assert.equal((await client.query('SELECT chunk_override FROM documents WHERE knowledge_base_id=$1',[tuningBase.id])).rows[0].chunk_override.chunkChars,1200,'explicit reprocessing applies current defaults');
    const tuningDocs=(await client.query('SELECT id::int FROM documents WHERE knowledge_base_id=$1 ORDER BY id',[tuningBase.id])).rows;
    await client.query("UPDATE documents SET status='ready',index_revision=1,index_pending=false WHERE knowledge_base_id=$1",[tuningBase.id]);
    await client.query("UPDATE document_blocks SET content='申请退货：选中文档的新内容' WHERE document_id=$1",[tuningDocs[0].id]);
    await client.query('UPDATE documents SET index_pending=true,index_revision=2 WHERE id=$1',[tuningDocs[0].id]);
    const pendingProfile=(await client.query('SELECT id::int FROM embedding_profiles ORDER BY id LIMIT 1')).rows[0].id;
    await indexes.configureSection(actor,tuningBase.id,'index',{indexMode:'high_quality',embeddingProfileId:pendingProfile});
    await client.query('UPDATE knowledge_bases SET auto_dirty=true WHERE id=$1',[tuningBase.id]);
    const autoVersion=await prepareAutoIndex(client,tuningBase.id);
    const autoRow=(await client.query('SELECT config,input_snapshot FROM knowledge_index_versions WHERE id=$1',[autoVersion])).rows[0];
    assert.equal(autoRow.config.indexMode,'economy','auto updates never apply a pending model change');
    assert.equal(autoRow.input_snapshot.filter(input=>input.sourceVersionId).length,1,'unselected document reuses frozen chunks');
    await buildKnowledgeIndex(workerPool,autoVersion,runtime);
    assert.equal((await bases.get(tuningBase.id)).activeIndexVersionId,autoVersion);
    assert.match((await indexes.documentChunks(tuningBase.id,tuningDocs[0].id)).chunks[0].content,/新内容/);
    assert.match((await indexes.documentChunks(tuningBase.id,tuningDocs[1].id)).chunks[0].content,/七天/);
    await client.query('UPDATE documents SET index_pending=true,index_revision=3 WHERE id=$1',[tuningDocs[0].id]);
    await client.query('UPDATE knowledge_bases SET auto_dirty=true WHERE id=$1',[tuningBase.id]);
    const superseded=await prepareAutoIndex(client,tuningBase.id);
    await indexes.activate(actor,tuningBase.id,tuningIndex.id);
    await buildKnowledgeIndex(workerPool,superseded,runtime);
    assert.equal((await bases.get(tuningBase.id)).activeIndexVersionId,tuningIndex.id,'in-flight auto build cannot undo rollback');
    await client.query('UPDATE documents SET archived_at=now() WHERE id=$1',[tuningDocs[1].id]);
    assert.deepEqual((await documents.list(50,0,tuningBase.id,false,'active')).map(d=>d.id),[tuningDocs[0].id]);
    assert.deepEqual((await documents.list(50,0,tuningBase.id,false,'archived')).map(d=>d.id),[tuningDocs[1].id]);
    assert.equal((await documents.list(1,1,tuningBase.id,false,'active')).length,0,'state is filtered before pagination');
    assert.equal((await documents.list(50,0,tuningBase.id)).length,2,'legacy list retains both states');
    assert.deepEqual((await documents.list(50,0,tuningBase.id,false,'all',[tuningDocs[0].id])).map(d=>d.id),[tuningDocs[0].id]);
    assert.equal((await documents.list(50,0,second.id,false,'all',[tuningDocs[0].id])).length,0,'requested IDs never escape their knowledge base');
    await client.query('UPDATE documents SET archived_at=NULL WHERE id=$1',[tuningDocs[1].id]);
    const oldHit=(await versionSearch.search('申请退货',5,tuningBase.id)).hits.find(hit=>hit.documentId===tuningDocs[0].id);
    await documents.recycle(actor,tuningDocs[0].id,tuningBase.id);
    assert.equal((await documents.list(50, 0, tuningBase.id)).some(doc => doc.id === tuningDocs[0].id), false);
    assert.equal((await documents.list(50, 0, tuningBase.id, true)).some(doc => doc.id === tuningDocs[0].id), true);
    assert.equal((await bases.list()).find(base => base.id === tuningBase.id).documentCount, 1, 'recycled documents do not count towards active documents');
    assert.equal((await versionSearch.search('申请退货',5,tuningBase.id)).hits.some(hit=>hit.documentId===tuningDocs[0].id),false);
    assert.equal((await new SearchService(database,{enabled:false},versionSearch).restoreEvidence([oldHit])).length,0,'deleted source cannot enter historical context');
    await indexes.activate(actor,tuningBase.id,autoVersion);
    assert.equal((await versionSearch.search('申请退货',5,tuningBase.id)).hits.some(hit=>hit.documentId===tuningDocs[0].id),false,'rollback cannot resurrect recycled source');
    await documents.recycle(actor,tuningDocs[0].id,tuningBase.id,true);
    assert.equal((await versionSearch.search('申请退货',5,tuningBase.id)).hits.some(hit=>hit.documentId===tuningDocs[0].id),true);
    const orphan=await documents.upload(actor,{originalname:'restored.md',buffer:Buffer.from('退款资料'),size:Buffer.byteLength('退款资料')},'恢复资料',tuningBase.id);
    await documents.recycle(actor,orphan.id,tuningBase.id);
    await documents.recycle(actor,orphan.id,tuningBase.id,true);
    assert.ok(autoQueued>0,'restoring an unindexed document schedules automatic update');
    const failedBuild=await indexes.build(actor,tuningBase.id,true).catch(()=>null);
    // The queued restored document blocks explicit full rebuild; old index stays live.
    assert.equal(failedBuild,null);
    let calls=0;
    fetchMock.mock.mockImplementation(async(_url,options)=>{
      calls++;const body=JSON.parse(options.body);const vector=body.model==='two-dimensional'?[1,0]:[1,0,0];
      return Response.json({data:body.input.map((_,index)=>({index,embedding:vector}))});
    });
    const scopes=[];
    for(const name of ['库甲','库乙']) {
      const library=await bases.create(actor,{name,draftConfig:{indexMode:'high_quality',retrievalMode:'hybrid',embeddingProfileId:pendingProfile}});
      const doc=await documents.upload(actor,{originalname:'policy.md',buffer:Buffer.from('申请退货政策'),size:Buffer.byteLength('申请退货政策')},name,library.id);
      await client.query("UPDATE documents SET status='ready' WHERE id=$1",[doc.id]);
      await client.query("INSERT INTO document_blocks(document_id,ordinal,block_type,heading_path,content,source_locator) VALUES($1,1,'paragraph','申请退货','联系客服办理申请退货','{\"type\":\"markdown_lines\",\"start\":1,\"end\":1}')",[doc.id]);
      const version=await indexes.build(actor,library.id);await buildKnowledgeIndex(workerPool,version.id,embeddingRuntime);await indexes.activate(actor,library.id,version.id);
      scopes.push({id:library.id,indexVersionId:version.id});
    }
    const before=calls;
    const fulltext=await embeddingSearch.searchMany('申请退货',scopes,agentRetrievalSchema.parse({topK:2}));
    assert.equal(fulltext.hits.length,2);
    assert.equal(fulltext.embeddingCalls,0,'default fulltext never generates a question embedding');
    assert.equal(calls,before);
    const many=await embeddingSearch.searchMany('申请退货',scopes,agentRetrievalSchema.parse({retrievalMode:'auto',topK:2}));
    assert.equal(many.hits.length,2);
    assert.equal(calls-before,1,'identical profile/connection shares one question embedding');
    assert.equal(many.embeddingCalls,1);
    const small=await embeddingSearch.searchMany('申请退货',scopes,agentRetrievalSchema.parse({retrievalMode:'auto',topK:1,contextChars:1000}));
    assert.equal(small.hits.length,1);
    assert.ok(small.hits.reduce((n,hit)=>n+Array.from(hit.content).length,0)<=1000);
    const otherProfile=(await client.query('SELECT id::int FROM embedding_profiles ORDER BY id DESC LIMIT 1')).rows[0].id;
    await indexes.configureSection(actor,scopes[1].id,'index',{indexMode:'high_quality',embeddingProfileId:otherProfile});
    const different=await indexes.build(actor,scopes[1].id);await buildKnowledgeIndex(workerPool,different.id,embeddingRuntime);await indexes.activate(actor,scopes[1].id,different.id);
    scopes[1].indexVersionId=different.id;
    const beforeDifferent=calls;
    await embeddingSearch.searchMany('申请退货',scopes,agentRetrievalSchema.parse({retrievalMode:'auto',topK:2}));
    assert.equal(calls-beforeDifferent,2,'different vector spaces generate independent question embeddings');
    await bases.archive(actor, second.id);
    assert.equal((await search.searchForAgent('隔离资料')).hits.length, 0);
    await assert.rejects(documents.upload(actor, file, '拒绝上传', second.id), (error) => error.getStatus() === 404);
    const legacy = (await documents.list(50, 0)).find(d=>!d.archivedAt);
    await client.query(`INSERT INTO document_chunks (document_id, ordinal, content, source_start_line, source_end_line)
      VALUES ($1, 1, '默认归档测试资料', 1, 1)`, [legacy.id]);
    assert.equal((await search.searchForAgent('默认归档测试资料')).hits.length, 1);
    const version = (await client.query(`INSERT INTO knowledge_index_versions
      (knowledge_base_id,status,config,input_snapshot,created_by)
      VALUES ($1,'ready','{}','[]',$2) RETURNING id`, [defaultBase.id, actor])).rows[0];
    await client.query(`INSERT INTO index_chunks (version_id,document_id,document_title,original_filename,ordinal,kind,
      heading_path,content,search_content,search_vector,source_locator)
      VALUES ($1,$2,'原有资料','old.md',1,'general','','默认归档测试资料','默认归档测试资料',
        to_tsvector('simple','默认归档测试资料'),'{}')`, [version.id, legacy.id]);
    await client.query('UPDATE knowledge_bases SET active_index_version_id=$2 WHERE id=$1', [defaultBase.id, version.id]);
    assert.equal((await versionSearch.search('默认归档测试资料', 5,defaultBase.id)).hits.length, 1);
    const documentRows = (await client.query('SELECT * FROM documents WHERE knowledge_base_id=$1 ORDER BY id', [defaultBase.id])).rows;
    const chunkRows = (await client.query('SELECT * FROM document_chunks WHERE document_id=$1 ORDER BY id', [legacy.id])).rows;
    const indexRows = (await client.query('SELECT * FROM knowledge_index_versions WHERE knowledge_base_id=$1 ORDER BY id', [defaultBase.id])).rows;
    const indexChunks = (await client.query('SELECT * FROM index_chunks WHERE version_id=$1 ORDER BY id', [version.id])).rows;
    assert.deepEqual(await bases.archive(actor, defaultBase.id), { id: defaultBase.id, archived: true });
    const archived = await bases.get(defaultBase.id);
    assert.ok(archived.archivedAt); assert.equal(archived.enabledForChat, false); assert.equal(archived.isDefault, true);
    assert.equal(String(archived.activeIndexVersionId), String(version.id));
    assert.equal((await search.searchForAgent('默认归档测试资料')).hits.length, 0);
    assert.equal((await versionSearch.search('默认归档测试资料', 5,defaultBase.id)).hits.length, 0);
    assert.equal((await search.diagnose('默认归档测试资料', 5, undefined)).results.length, 0);
    assert.deepEqual((await client.query('SELECT * FROM documents WHERE knowledge_base_id=$1 ORDER BY id', [defaultBase.id])).rows, documentRows);
    assert.deepEqual((await client.query('SELECT * FROM document_chunks WHERE document_id=$1 ORDER BY id', [legacy.id])).rows, chunkRows);
    assert.deepEqual((await client.query('SELECT * FROM knowledge_index_versions WHERE knowledge_base_id=$1 ORDER BY id', [defaultBase.id])).rows, indexRows);
    assert.deepEqual((await client.query('SELECT * FROM index_chunks WHERE version_id=$1 ORDER BY id', [version.id])).rows, indexChunks);
    for (const baseId of [undefined, defaultBase.id]) {
      await assert.rejects(documents.upload(actor, file, '拒绝写入已归档默认库', baseId), error => error.getStatus() === 404);
    }
    await assert.rejects(bases.archive(actor, defaultBase.id), error => error.getStatus() === 404);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM audit_logs WHERE action='knowledge_base.archived' AND target_id=$1", [String(defaultBase.id)])).rows[0].count, 1);
    assert.deepEqual(await bases.unarchive(actor, defaultBase.id), { id: defaultBase.id, archived: false });
    const restoredBase = await bases.get(defaultBase.id);
    assert.equal(restoredBase.archivedAt, null);
    assert.equal(restoredBase.enabledForChat, false);
    assert.equal(String(restoredBase.activeIndexVersionId), String(version.id));
    const restoredSearch = new SearchService(database, {enabled:false}, versionSearch);
    const restoredScope = [{id:defaultBase.id,indexVersionId:Number(version.id)}];
    assert.equal((await restoredSearch.searchForAgent('默认归档测试资料', 5,restoredScope)).hits.length, 0);
    await assert.rejects(bases.unarchive(actor, defaultBase.id), error => error.getStatus() === 404);
    await bases.update(actor, defaultBase.id, { enabledForChat: true });
    assert.equal((await restoredSearch.searchForAgent('默认归档测试资料', 5,restoredScope)).hits.length, 1);
    assert.deepEqual((await client.query('SELECT * FROM documents WHERE knowledge_base_id=$1 ORDER BY id', [defaultBase.id])).rows, documentRows);
    assert.deepEqual((await client.query('SELECT * FROM knowledge_index_versions WHERE knowledge_base_id=$1 ORDER BY id', [defaultBase.id])).rows, indexRows);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
    await rm(uploadRoot, { recursive: true, force: true });
  }
});
