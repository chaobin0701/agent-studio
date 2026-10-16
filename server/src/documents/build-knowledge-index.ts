import { Pool } from 'pg';
import { AppConfigService } from '../config/config.service';
import { buildChunks, searchTokens } from './build-chunks';
import { buildSettings, processingSettings } from './knowledge-config';
import { indexInputSchema } from './knowledge-index.service';
import { embeddingProfileSchema } from './profile-embedding';
import { embedForProfile } from './embedding-runtime';
import { assertIndexCompatible } from './index-compatibility';
import { ConflictException } from '@nestjs/common';

async function copyDocument(client: any, sourceVersionId: number, target: any, documentId: number) {
  const source=(await client.query("SELECT knowledge_base_id,config,embedding_snapshot FROM knowledge_index_versions WHERE id=$1 AND status='ready'",[sourceVersionId])).rows[0];
  if(!source || source.knowledge_base_id!==target.knowledge_base_id ||
    JSON.stringify(source.embedding_snapshot)!==JSON.stringify(target.embedding_snapshot)) throw new Error('Incompatible index reuse');
  const chunks=(await client.query('SELECT * FROM index_chunks WHERE version_id=$1 AND document_id=$2 ORDER BY ordinal',[sourceVersionId,documentId])).rows;
  const ids=new Map();
  for(const c of chunks) {
    const inserted=(await client.query(`INSERT INTO index_chunks(version_id,document_id,ordinal,kind,parent_chunk_id,
      heading_path,content,search_content,search_vector,source_locator,document_title,original_filename)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [target.id,documentId,c.ordinal,c.kind,c.parent_chunk_id?ids.get(c.parent_chunk_id):null,c.heading_path,c.content,c.search_content,c.search_vector,c.source_locator,c.document_title,c.original_filename])).rows[0];
    ids.set(c.id,inserted.id);
    await client.query('INSERT INTO chunk_embeddings(chunk_id,embedding,dimensions) SELECT $1,embedding,dimensions FROM chunk_embeddings WHERE chunk_id=$2',[inserted.id,c.id]);
  }
  return chunks.length;
}

export async function buildKnowledgeIndex(pool: Pool, versionId: number, runtime: AppConfigService): Promise<void> {
  if (!Number.isSafeInteger(versionId) || versionId < 1) throw new Error('Invalid version ID');
  const client = await pool.connect();
  // Transaction-scoped advisory lock serializes retries. A crashed worker releases it.
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73191, $1::int)', [versionId]);
    const row = (await client.query('SELECT * FROM knowledge_index_versions WHERE id=$1 FOR UPDATE', [versionId])).rows[0];
    if (!row || row.status !== 'building') { await client.query('COMMIT'); return; }
    const config = buildSettings(row.config);
    const inputs = indexInputSchema.parse(row.input_snapshot);
    const profile = config.indexMode === 'high_quality' ? embeddingProfileSchema.parse(row.embedding_snapshot) : null;
    await client.query('DELETE FROM index_chunks WHERE version_id=$1', [versionId]);
    let count = 0;
    for (const input of inputs) {
      if(input.sourceVersionId) { count+=await copyDocument(client,input.sourceVersionId,row,input.documentId);continue; }
      const chunks = buildChunks(input.blocks, { ...config, ...processingSettings({ ...config, ...input.processingConfig }) });
      const searchable = chunks.filter((chunk) => chunk.kind !== 'parent');
      const vectors = profile ? await embedForProfile(client, runtime, profile, searchable.map((chunk) => chunk.kind === 'faq' ? chunk.headingPath : `${chunk.headingPath}\n${chunk.content}`)) : [];
      const parents = new Map<number, number>();
      let vectorIndex = 0;
      for (const chunk of chunks) {
        const searchContent = chunk.kind === 'faq' ? chunk.headingPath : `${chunk.headingPath}\n${chunk.content}`;
        const inserted = (await client.query(`INSERT INTO index_chunks
          (version_id,document_id,ordinal,kind,parent_chunk_id,heading_path,content,search_content,search_vector,source_locator,document_title,original_filename)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_tsvector('simple',$9),$10,$11,$12) RETURNING id::int`,
        [versionId, input.documentId, chunk.ordinal, chunk.kind,
          chunk.parentOrdinal === null ? null : parents.get(chunk.parentOrdinal), chunk.headingPath,
          chunk.content, searchContent, searchTokens(searchContent), JSON.stringify(chunk.sourceLocator),input.documentTitle,input.originalFilename])).rows[0];
        if (chunk.kind === 'parent') parents.set(chunk.ordinal, inserted.id);
        else if (profile) {
          await client.query('INSERT INTO chunk_embeddings(chunk_id,embedding,dimensions) VALUES ($1,$2::vector,$3)',
            [inserted.id, `[${vectors[vectorIndex++].join(',')}]`, profile.dimensions]);
        }
        count++;
      }
    }
    await client.query("UPDATE knowledge_index_versions SET status='ready',chunk_count=$2,error_message=NULL,finished_at=now() WHERE id=$1", [versionId, count]);
    if(row.auto_activate) {
      const kb=(await client.query('SELECT index_epoch,active_index_version_id FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR UPDATE',[row.knowledge_base_id])).rows[0];
      if(kb && kb.index_epoch===row.expected_epoch && kb.active_index_version_id===row.base_version_id) {
        try {
          await assertIndexCompatible(client,row.knowledge_base_id,config,row.embedding_snapshot);
          await client.query('UPDATE knowledge_bases SET active_index_version_id=$2,index_error=NULL WHERE id=$1',[row.knowledge_base_id,versionId]);
          for(const input of inputs) await client.query('UPDATE documents SET index_pending=false WHERE id=$1 AND index_revision=$2',[input.documentId,input.documentRevision??1]);
          await client.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'knowledge_index.auto_activated','knowledge_base',$2,$3)",[row.created_by,String(row.knowledge_base_id),JSON.stringify({versionId})]);
        } catch(error) {
          if(!(error instanceof ConflictException))throw error;
          await client.query("UPDATE knowledge_bases SET index_error='索引已构建，但与已发布 Agent 的检索策略不兼容，未切换' WHERE id=$1",[row.knowledge_base_id]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    // Do not persist SDK payloads, credentials or input content in errors.
    await client.query("UPDATE knowledge_index_versions SET status='failed',error_message='Index build failed; check worker configuration and retry',finished_at=now() WHERE id=$1 AND status <> 'ready'", [versionId]);
    await client.query("UPDATE knowledge_bases SET index_error='索引构建失败，当前版本继续可用' WHERE id=(SELECT knowledge_base_id FROM knowledge_index_versions WHERE id=$1)",[versionId]);
    throw new Error('Knowledge index build failed', { cause: error });
  } finally { client.release(); }
}
