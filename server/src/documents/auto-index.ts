import type { PoolClient } from 'pg';
import { buildSettings } from './knowledge-config';
import { indexInputSchema } from './knowledge-index.service';

/** Caller owns the transaction. One locked KB serializes upload batches and builds.
 * Auto updates use the active settings, never an unapplied model draft. */
export async function prepareAutoIndex(client: PoolClient, id: number): Promise<number | null> {
  const kb=(await client.query('SELECT * FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR UPDATE',[id])).rows[0];
  if(!kb?.auto_dirty)return null;
  if((await client.query("SELECT 1 FROM knowledge_index_versions WHERE knowledge_base_id=$1 AND status='building'",[id])).rowCount)
    throw new Error('Knowledge index build is still running');
  if((await client.query("SELECT 1 FROM documents WHERE knowledge_base_id=$1 AND deleted_at IS NULL AND archived_at IS NULL AND processing_epoch=$2 AND index_pending AND status IN ('queued','processing')",[id,kb.index_epoch])).rowCount)
    throw new Error('Knowledge documents are still processing');
  const active=kb.active_index_version_id ? (await client.query("SELECT * FROM knowledge_index_versions WHERE id=$1 AND knowledge_base_id=$2 AND status='ready'",[kb.active_index_version_id,id])).rows[0] : null;
  const config=buildSettings(active?.config ?? kb.draft_config);
  const documents=(await client.query(`SELECT d.*,COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'ordinal',b.ordinal,'blockType',b.block_type,'headingPath',b.heading_path,'content',b.content,'sourceLocator',b.source_locator) ORDER BY b.ordinal)
    FROM document_blocks b WHERE b.document_id=d.id),'[]') AS blocks,
    (SELECT jsonb_build_object('documentTitle',c.document_title,'originalFilename',c.original_filename)
      FROM index_chunks c WHERE c.document_id=d.id AND c.version_id=$2 ORDER BY c.ordinal LIMIT 1) AS frozen
    FROM documents d WHERE d.knowledge_base_id=$1 AND d.archived_at IS NULL AND d.deleted_at IS NULL ORDER BY d.id`,[id,active?.id??null])).rows;
  let changed=false;
  const inputs=[];
  for(const d of documents) {
    const pending=d.index_pending && d.processing_epoch===kb.index_epoch;
    if((pending || !active) && d.status==='ready' && d.blocks.length) {
      changed=true;
      inputs.push({documentId:Number(d.id),documentTitle:d.title,originalFilename:d.original_filename,
        documentRevision:d.index_revision,processingConfig:d.chunk_override,blocks:d.blocks});
    } else if(d.frozen) {
      const old=active.input_snapshot.find((input:any)=>input.documentId===Number(d.id));
      inputs.push({documentId:Number(d.id),...d.frozen,documentRevision:old?.documentRevision??1,
        processingConfig:old?.processingConfig,sourceVersionId:Number(active.id),blocks:[]});
    }
  }
  await client.query('UPDATE knowledge_bases SET auto_dirty=false WHERE id=$1',[id]);
  if(!changed || !inputs.length)return null;
  let profile=active?.embedding_snapshot??null;
  if(!active && config.indexMode==='high_quality') {
    profile=(await client.query('SELECT config FROM embedding_profiles WHERE id=$1 AND enabled',[config.embeddingProfileId])).rows[0]?.config;
    if(!profile)throw new Error('Embedding profile is unavailable');
  }
  const actor=documents.find(d=>d.index_pending)?.uploaded_by ?? documents[0].uploaded_by;
  const version=(await client.query(`INSERT INTO knowledge_index_versions
    (knowledge_base_id,status,config,embedding_snapshot,input_snapshot,created_by,auto_activate,expected_epoch,base_version_id)
    VALUES($1,'building',$2,$3,$4,$5,true,$6,$7) RETURNING id::int`,
    [id,JSON.stringify(config),profile?JSON.stringify(profile):null,JSON.stringify(indexInputSchema.parse(inputs)),actor,kb.index_epoch,active?.id??null])).rows[0];
  await client.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'knowledge_index.auto_requested','knowledge_base',$2,$3)",[actor,String(id),JSON.stringify({versionId:version.id})]);
  return version.id;
}
