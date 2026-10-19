import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { DatabaseService } from '../dist/database.service.js';
import { DocumentQueueService, DOCUMENT_INGEST_QUEUE, KNOWLEDGE_INDEX_QUEUE, KNOWLEDGE_AUTO_QUEUE } from '../dist/documents/document-queue.service.js';
import { KnowledgeIndexService } from '../dist/documents/knowledge-index.service.js';
import { inWorkspace } from '../dist/workspaces/workspace-context.js';

test('PostgreSQL fresh startup: workspace transactions enqueue all document jobs atomically', { skip: process.env.KB_INTEGRATION !== '1' }, async () => {
  const root = new Client({ connectionString: process.env.DATABASE_URL });
  const name = 'queue_test_' + randomUUID().replaceAll('-', '');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + name;
  let created = false, client, database, queue;
  await root.connect();
  try {
    // A separate database reproduces migrations running before pg-boss exists,
    // without changing queue permissions or consuming jobs in the application DB.
    await root.query(`CREATE DATABASE "${name}"`);
    created = true;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort())
      await client.query((await readFile(new URL(file, directory), 'utf8')).split('-- Down Migration')[0]);
    assert.equal((await client.query("SELECT to_regnamespace('pgboss') AS schema")).rows[0].schema, null);

    database = new DatabaseService({ databaseUrl: url.toString() });
    queue = new DocumentQueueService({ databaseUrl: url.toString() });
    await queue.onModuleInit();
    assert.equal((await database.query("SELECT has_schema_privilege(current_user,'pgboss','USAGE') AS allowed")).rows[0].allowed, true);
    const actor = Number((await client.query("INSERT INTO admins(email,password_hash,display_name) VALUES('queue@fixture.invalid','fixture','queue') RETURNING id")).rows[0].id);
    const base = Number((await database.query("INSERT INTO knowledge_bases(name,draft_config) VALUES('Queue fixture','{}') RETURNING id")).rows[0].id);
    const document = Number((await database.query(`INSERT INTO documents(knowledge_base_id,title,original_filename,storage_key,sha256,byte_size,uploaded_by,status)
      VALUES($1,'Fixture','fixture.md','fixture.md',repeat('a',64),1,$2,'ready') RETURNING id`, [base, actor])).rows[0].id);
    await database.query(`INSERT INTO document_blocks(document_id,ordinal,block_type,heading_path,content,source_locator)
      VALUES($1,1,'paragraph','Fixture','Queue regression test','{"type":"markdown_lines","start":1,"end":1}')`, [document]);
    const indexes = new KnowledgeIndexService(database, queue);
    const version = await indexes.build(actor, base);
    const jobs = (await queue.boss.fetch(KNOWLEDGE_INDEX_QUEUE)).map(job => job.data);
    assert.deepEqual(jobs, [{ versionId: version.id, workspaceId: 1 }]);
    assert.equal((await database.query('SELECT status FROM knowledge_index_versions WHERE id=$1', [version.id])).rows[0].status, 'building');

    const countJobs = async () => Number((await client.query('SELECT count(*) FROM pgboss.job')).rows[0].count);
    const before = await countJobs();
    await assert.rejects(database.transaction(async transaction => {
      await queue.enqueue(transaction, document);
      await queue.enqueueIndex(transaction, version.id);
      await queue.enqueueAuto(transaction, base);
      throw Error('rollback fixture');
    }), /rollback fixture/);
    assert.equal(await countJobs(), before, 'rolled-back resource changes must not leave queued work');
    await database.transaction(async transaction => {
      await queue.enqueue(transaction, document);
      await queue.enqueueAuto(transaction, base);
    });
    assert.deepEqual((await queue.boss.fetch(DOCUMENT_INGEST_QUEUE)).map(job => job.data), [{ documentId: document, workspaceId: 1 }]);
    assert.deepEqual((await queue.boss.fetch(KNOWLEDGE_AUTO_QUEUE)).map(job => job.data), [{ knowledgeBaseId: base, workspaceId: 1 }]);

    const other = Number((await client.query("INSERT INTO workspaces(name) VALUES('Other workspace') RETURNING id")).rows[0].id);
    await inWorkspace(other, async () => {
      await assert.rejects(indexes.build(actor, base), error => error.getStatus() === 404);
      assert.equal((await database.query('SELECT 1 FROM documents WHERE id=$1', [document])).rowCount, 0);
    });
    assert.equal(await countJobs(), before + 2, 'a foreign workspace cannot enqueue a build for this base');
  } finally {
    try {
      if (queue) await queue.onModuleDestroy();
      if (database) await database.onModuleDestroy();
      if (client) await client.end();
    } finally {
      if (created) await root.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await root.end();
    }
  }
});
