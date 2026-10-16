import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { DOCUMENT_INGEST_QUEUE, KNOWLEDGE_INDEX_QUEUE, KNOWLEDGE_AUTO_QUEUE } from './documents/document-queue.service';
import { prepareAutoIndex } from './documents/auto-index';
import { buildKnowledgeIndex } from './documents/build-knowledge-index';
import { documentPath } from './documents/document-storage';
import { EmbeddingService } from './documents/embedding.service';
import { parseDocument, ScannedPdfError } from './documents/extract-document';
import { AppConfigService } from './config/config.service';
import { DOCUMENT_PARSER_VERSION } from './documents/document-block';
import { buildSettings } from './documents/knowledge-config';
import { inWorkspace, DEFAULT_WORKSPACE_ID, currentWorkspaceId } from './workspaces/workspace-context';
import { scopedPool } from './workspaces/scoped-pool';
import { purgeUnavailableArtifacts } from './artifacts/retention';

let bossForAuto: PgBoss | undefined;
type DocumentJob = { documentId: number;workspaceId?:number };
const runtimeConfig = new AppConfigService();
const embeddings = new EmbeddingService(runtimeConfig);

async function processDocument(pool: Pool, documentId: number): Promise<void> {
  if (!Number.isSafeInteger(documentId) || documentId <= 0) throw new Error('Invalid document ID');
  const claimed = await pool.query<{ storage_key: string; inline_content: string | null; sha256: string; byte_size: number; legacy: boolean; draftConfig: unknown; knowledge_base_id: number;processing_epoch:number; processingConfig: { chunkChars?: number; overlapChars?: number; separatorMode?: 'auto' | 'heading_paragraph' | 'fixed'; preserveHeading?: boolean } | null }>(
    `UPDATE documents SET status = 'processing', error_message = NULL, updated_at = now()
     WHERE id = $1 AND archived_at IS NULL AND deleted_at IS NULL AND source_type='file' AND status IN ('pending', 'queued', 'failed', 'extracted', 'processing')
     RETURNING storage_key, inline_content, sha256, byte_size,knowledge_base_id,processing_epoch,
       (SELECT kb.draft_config FROM knowledge_bases kb WHERE kb.id=documents.knowledge_base_id) AS "draftConfig",
       chunk_override AS "processingConfig",
       (SELECT kb.is_default AND kb.active_index_version_id IS NULL AND kb.draft_config = '{}'::jsonb
        FROM knowledge_bases kb WHERE kb.id=documents.knowledge_base_id) AS legacy`, [documentId],
  );
  const document = claimed.rows[0];
  if (!document) return;

  try {
    const indexConfig = buildSettings(document.draftConfig);
    const bytes = document.inline_content === null ? await readFile(documentPath(document.storage_key, runtimeConfig)) : Buffer.from(document.inline_content);
    if (bytes.length !== document.byte_size || createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
      throw new Error('Stored file failed integrity check');
    }
    const processing = document.processingConfig;
    const parsed = await parseDocument(bytes, document.inline_content === null ? document.storage_key : "converted.md", processing?.chunkChars ?? indexConfig.chunkChars, processing?.overlapChars ?? indexConfig.overlapChars, processing ?? undefined);
    // Embedding belongs to index construction, not document parsing.
    const vectors: number[][] = [];
    const embeddingModel = null, fingerprint = null, profileId = null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ status: string; archived_at: Date | null }>(
        'SELECT status, archived_at,deleted_at FROM documents WHERE id = $1 FOR UPDATE', [documentId],
      );
      if (!current.rows[0] || current.rows[0].archived_at || (current.rows[0] as any).deleted_at || current.rows[0].status !== 'processing') {
        await client.query('COMMIT');
        return;
      }
      await client.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
      await client.query('DELETE FROM document_blocks WHERE document_id = $1', [documentId]);
      await client.query(`INSERT INTO document_blocks
        (document_id, ordinal, block_type, heading_path, content, source_locator)
        SELECT $1, x.ordinal, x."blockType", x."headingPath", x.content, x."sourceLocator"
        FROM jsonb_to_recordset($2::jsonb) AS x(ordinal integer, "blockType" text,
          "headingPath" text, content text, "sourceLocator" jsonb)`, [documentId, JSON.stringify(parsed.blocks)]);
      await client.query(
        `INSERT INTO document_chunks
           (document_id, ordinal, heading_path, content, source_start_line, source_end_line, embedding, embedding_model, embedding_fingerprint, embedding_profile_id)
         SELECT $1, x.ordinal, x."headingPath", x.content, x."sourceStartLine", x."sourceEndLine",
                x.embedding::vector, x."embeddingModel", x.fingerprint, x."profileId"
         FROM jsonb_to_recordset($2::jsonb) AS x(
           ordinal integer, "headingPath" text, content text,
           "sourceStartLine" integer, "sourceEndLine" integer,
           embedding text, "embeddingModel" text, fingerprint text, "profileId" bigint)`,
        [documentId, JSON.stringify(parsed.chunks.map((chunk, index) => ({
          ...chunk,
          embedding: vectors[index] ? `[${vectors[index].join(',')}]` : null,
          embeddingModel: vectors[index] ? embeddingModel : null,
          fingerprint: vectors[index] ? fingerprint : null,
          profileId: vectors[index] ? profileId : null,
        })))],
      );
      await client.query(
        `UPDATE documents SET extracted_text = $1, status = 'ready', error_message = NULL,
                parser_version = $3, parser_warnings=$4, updated_at = now() WHERE id = $2`,
        [parsed.extractedText, documentId, DOCUMENT_PARSER_VERSION, JSON.stringify(parsed.warnings ?? [])],
      );
      await client.query('UPDATE knowledge_bases SET auto_dirty=true WHERE id=$1 AND index_epoch=$2',[document.knowledge_base_id,document.processing_epoch]);
      await bossForAuto?.send(KNOWLEDGE_AUTO_QUEUE,{knowledgeBaseId:document.knowledge_base_id,workspaceId:currentWorkspaceId()},{retryLimit:30,retryDelay:2,db:{executeSql:(sql,values)=>client.query(sql,values)}});
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const safeMessage = error instanceof ScannedPdfError
      ? error.message
      : error instanceof Error && /^(Document|Stored file|Embedding|Invalid|Unsupported|PDF|DOCX)/u.test(error.message)
        ? error.message.slice(0, 300)
        : 'Unable to process document';
    await pool.query(
      `UPDATE documents SET status = 'failed', error_message = $2, updated_at = now()
       WHERE id = $1 AND archived_at IS NULL AND status = 'processing'`,
      [documentId, safeMessage],
    );
    await pool.query('UPDATE knowledge_bases SET auto_dirty=true WHERE id=$1 AND index_epoch=$2',[document.knowledge_base_id,document.processing_epoch]);
    await bossForAuto?.send(KNOWLEDGE_AUTO_QUEUE,{knowledgeBaseId:document.knowledge_base_id,workspaceId:currentWorkspaceId()},{retryLimit:30,retryDelay:2});
    throw error;
  }
}

async function bootstrap(): Promise<void> {
  const connectionString = runtimeConfig.databaseUrl;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const boss = new PgBoss(connectionString);
  bossForAuto=boss;
  const pool = scopedPool(new Pool({ connectionString }));
  boss.on('error', (error) => console.error('Worker queue error:', error));
  await boss.start();
  await boss.createQueue(DOCUMENT_INGEST_QUEUE);
  await boss.createQueue(KNOWLEDGE_INDEX_QUEUE);
  await boss.createQueue(KNOWLEDGE_AUTO_QUEUE);
  await boss.work<{knowledgeBaseId:number;workspaceId:number}>(KNOWLEDGE_AUTO_QUEUE,async([job])=>inWorkspace(job.data.workspaceId,async()=>{
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const versionId=await prepareAutoIndex(client,job.data.knowledgeBaseId);
      if(versionId)await boss.send(KNOWLEDGE_INDEX_QUEUE,{versionId,workspaceId:job.data.workspaceId},{retryLimit:2,retryDelay:10,db:{executeSql:(sql,values)=>client.query(sql,values)}});
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }));
  await boss.work<{ versionId: number;workspaceId?:number }>(KNOWLEDGE_INDEX_QUEUE, async ([job]) => {
    await inWorkspace(job.data.workspaceId??DEFAULT_WORKSPACE_ID,async()=>{
      await buildKnowledgeIndex(pool,job.data.versionId,runtimeConfig);
      const kb=(await pool.query('SELECT k.id::int FROM knowledge_bases k JOIN knowledge_index_versions v ON v.knowledge_base_id=k.id WHERE v.id=$1 AND k.auto_dirty',[job.data.versionId])).rows[0];
      if(kb)await boss.send(KNOWLEDGE_AUTO_QUEUE,{knowledgeBaseId:kb.id,workspaceId:job.data.workspaceId??DEFAULT_WORKSPACE_ID},{retryLimit:30,retryDelay:2});
    });
  });
  await boss.work<DocumentJob>(DOCUMENT_INGEST_QUEUE, async ([job]) => inWorkspace(job.data.workspaceId??DEFAULT_WORKSPACE_ID,async()=> {
    const lock = await pool.connect();
    try {
      const acquired = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(73192,$1::int) AS locked', [job.data.documentId]);
      if (!acquired.rows[0].locked) throw new Error('Document processing is already running');
      // A retried job can reclaim processing after a worker crash, but never run concurrently.
      try { await processDocument(pool, job.data.documentId); }
      finally { await lock.query('SELECT pg_advisory_unlock(73192,$1::int)', [job.data.documentId]); }
    } finally { lock.release(); }
  }));
  const sweep=async()=>{
    const spaces=(await pool.query('SELECT id::int FROM workspaces WHERE enabled')).rows;
    for(const space of spaces)await inWorkspace(space.id,async()=>{
      const bases=(await pool.query('SELECT id::int FROM knowledge_bases WHERE auto_dirty AND archived_at IS NULL')).rows;
      for(const base of bases)await boss.send(KNOWLEDGE_AUTO_QUEUE,{knowledgeBaseId:base.id,workspaceId:space.id},{retryLimit:30,retryDelay:2,singletonKey:String(base.id),singletonSeconds:5});
    });
  };
  await sweep();
  const cleanArtifacts=async()=>{await purgeUnavailableArtifacts(pool);await pool.query('SELECT purge_unavailable_chatbot_attachments(100)');};
  await cleanArtifacts();
  let cleaningArtifacts=false;
  const artifactTimer=setInterval(()=>{if(!cleaningArtifacts){cleaningArtifacts=true;void cleanArtifacts().catch(()=>console.error('Execution artifact retention failed')).finally(()=>{cleaningArtifacts=false;});}},60000);
  let sweeping=false;
  const sweepTimer=setInterval(()=>{if(!sweeping){sweeping=true;void sweep().catch(()=>console.error('Auto-index recovery sweep failed')).finally(()=>{sweeping=false;});}},10000);
  console.log(`Worker ready for document extraction and chunking; embeddings ${embeddings.enabled ? 'enabled' : 'disabled'}.`);

  const shutdown = async (): Promise<void> => {
    clearInterval(sweepTimer);
    clearInterval(artifactTimer);
    await boss.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void bootstrap();
