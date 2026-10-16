import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { DocumentQueueService } from './document-queue.service';
import { buildChunks, searchTokens } from './build-chunks';
import { documentBlockSchema, knowledgeConfigSchema, buildSettings, processingSettings, indexSettings,
  retrievalSettings, processingConfigSchema, indexConfigSchema, retrievalConfigSchema, type BuildConfig } from './knowledge-config';
import type { PoolClient } from 'pg';
import { embeddingFingerprint, embeddingProfileSchema } from './profile-embedding';
import { assertIndexCompatible } from './index-compatibility';

export const indexInputSchema = z.array(z.object({
  documentId: z.number().int().positive(),
  documentTitle: z.string(), originalFilename: z.string(),
  processingConfig: z.record(z.string(), z.unknown()).nullable().optional(),
  documentRevision: z.number().int().positive().optional(),
  sourceVersionId: z.number().int().positive().optional(),
  blocks: z.array(documentBlockSchema).default([]),
})).min(1);

@Injectable()
export class KnowledgeIndexService {
  constructor(private readonly database: DatabaseService, private readonly queue: DocumentQueueService) {}

  async saveSettings(actorId: number, id: number, input: unknown) {
    const parsed = z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(2000),
      processingConfig: processingConfigSchema,
      indexConfig: indexConfigSchema,
    }).strict().safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue => issue.message).join('; '));
    const value = parsed.data;
    return this.database.transaction(async client => {
      const kb = (await client.query('SELECT draft_config,active_index_version_id FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!kb) throw new NotFoundException('Active knowledge base not found');
      const next = buildSettings({ ...value.processingConfig, ...value.indexConfig });
      if (next.embeddingProfileId && !(await client.query('SELECT id FROM embedding_profiles WHERE id=$1 AND enabled FOR SHARE', [next.embeddingProfileId])).rowCount)
        throw new BadRequestException('Enabled embedding profile required');
      const previous = buildSettings(kb.draft_config);
      if (!kb.active_index_version_id && (previous.indexMode !== next.indexMode || previous.embeddingProfileId !== next.embeddingProfileId))
        await this.freezeLiveIndex(client, actorId, id, previous);
      await client.query('UPDATE knowledge_bases SET name=$2,description=$3,draft_config=$4,updated_at=now() WHERE id=$1', [id, value.name, value.description, JSON.stringify(next)]);
      await client.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'knowledge_base.settings_updated','knowledge_base',$2,$3)", [actorId, String(id), JSON.stringify(value)]);
      return value;
    });
  }

  async configureSection(actorId: number, id: number, section: 'processing' | 'index' | 'retrieval', input: unknown) {
    if(section==='retrieval')throw new BadRequestException('Retrieval strategy is managed by the Agent');
    const schema = section === 'processing' ? processingConfigSchema : section === 'index' ? indexConfigSchema : retrievalConfigSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map(issue => issue.message).join('; '));
    return this.database.transaction(async client => {
      const kb = (await client.query('SELECT draft_config,active_index_version_id FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!kb) throw new NotFoundException('Active knowledge base not found');
        const next = buildSettings({ ...kb.draft_config, ...parsed.data });
        if (next.embeddingProfileId && !(await client.query('SELECT id FROM embedding_profiles WHERE id=$1 AND enabled FOR SHARE',[next.embeddingProfileId])).rowCount)
          throw new BadRequestException('Enabled embedding profile required');
        const previous = buildSettings(kb.draft_config);
        if (section === 'index' && !kb.active_index_version_id && (previous.indexMode !== next.indexMode || previous.embeddingProfileId !== next.embeddingProfileId))
          await this.freezeLiveIndex(client,actorId,id,previous);
        await client.query('UPDATE knowledge_bases SET draft_config=$2,updated_at=now() WHERE id=$1',[id,JSON.stringify(next)]);
      await client.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'knowledge_base.settings_updated','knowledge_base',$2,$3)", [actorId,String(id),JSON.stringify({section,settings:parsed.data})]);
      return parsed.data;
    });
  }

  async configure(actorId: number, id: number, input: unknown) {
    const parsed = knowledgeConfigSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((v) => v.message).join('; '));
    return this.database.transaction(async (client) => {
      const kb = (await client.query('SELECT draft_config,active_index_version_id FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!kb) throw new NotFoundException('Active knowledge base not found');
      if (parsed.data.embeddingProfileId) {
        const selected = await client.query('SELECT id FROM embedding_profiles WHERE id=$1 AND enabled FOR SHARE', [parsed.data.embeddingProfileId]);
        if (!selected.rowCount) throw new BadRequestException('Enabled embedding profile required');
      }
      const previous = knowledgeConfigSchema.parse(kb.draft_config);
      if (!kb.active_index_version_id && (previous.indexMode !== parsed.data.indexMode || previous.embeddingProfileId !== parsed.data.embeddingProfileId)) {
        await this.freezeLiveIndex(client, actorId, id, previous);
      }
      const updated = await client.query(`UPDATE knowledge_bases SET draft_config = $2, updated_at = now()
        WHERE id = $1 AND archived_at IS NULL RETURNING draft_config`, [id, JSON.stringify(parsed.data)]);
      if (!updated.rowCount) throw new NotFoundException('Active knowledge base not found');
      await client.query(`INSERT INTO audit_logs (actor_admin_id,action,target_type,target_id)
        VALUES ($1,'knowledge_base.configured','knowledge_base',$2)`, [actorId, String(id)]);
      return parsed.data;
    });
  }

  /** A legacy/live index has no version pointer. Freeze it before replacing its
   * vector space, so uploads and draft settings cannot invalidate chat queries. */
  private async freezeLiveIndex(client: PoolClient, actorId: number, id: number, config: BuildConfig) {
    const chunks = (await client.query(`SELECT c.*,d.title,d.original_filename,d.source_type
      FROM document_chunks c JOIN documents d ON d.id=c.document_id
      WHERE d.knowledge_base_id=$1 AND d.archived_at IS NULL AND d.status='ready' ORDER BY d.id,c.ordinal`, [id])).rows;
    if (!chunks.length) return;
    const profileRow = config.embeddingProfileId ? (await client.query('SELECT config FROM embedding_profiles WHERE id=$1 FOR SHARE', [config.embeddingProfileId])).rows[0] : null;
    const profile = profileRow ? embeddingProfileSchema.parse(profileRow.config) : null;
    if (config.indexMode === 'high_quality' && !profile) throw new ConflictException('Previous embedding profile is unavailable; cannot preserve the current index');
    const version = (await client.query(`INSERT INTO knowledge_index_versions
      (knowledge_base_id,status,config,embedding_snapshot,input_snapshot,chunk_count,created_by,finished_at)
      VALUES ($1,'ready',$2,$3,'[]',$4,$5,now()) RETURNING id::int`,
    [id, JSON.stringify(config), profile ? JSON.stringify(profile) : null, chunks.length, actorId])).rows[0];
    for (const chunk of chunks) {
      const searchContent = `${chunk.heading_path}\n${chunk.content}`;
      const locatorType = chunk.source_type === 'faq' ? 'faq_entry' : /\.pdf$/iu.test(chunk.original_filename) ? 'pdf_page'
        : /\.docx$/iu.test(chunk.original_filename) ? 'docx_paragraph' : 'markdown_lines';
      const inserted = (await client.query(`INSERT INTO index_chunks
        (version_id,document_id,ordinal,kind,heading_path,content,search_content,search_vector,source_locator,document_title,original_filename)
        VALUES($1,$2,$3,'general',$4,$5,$6,to_tsvector('simple',$7),$8,$9,$10) RETURNING id::int`,
      [version.id, chunk.document_id, chunk.ordinal, chunk.heading_path, chunk.content, searchContent, searchTokens(searchContent),
        JSON.stringify({ type:locatorType,start:chunk.source_start_line,end:chunk.source_end_line }), chunk.title, chunk.original_filename])).rows[0];
      if (profile && chunk.embedding_fingerprint === embeddingFingerprint(profile)) {
        await client.query(`INSERT INTO chunk_embeddings(chunk_id,embedding,dimensions)
          SELECT $1,embedding,$3 FROM document_chunks WHERE id=$2 AND embedding IS NOT NULL AND vector_dims(embedding)=$3`,
        [inserted.id, chunk.id, profile.dimensions]);
      }
    }
    await client.query('UPDATE knowledge_bases SET active_index_version_id=$2 WHERE id=$1', [id,version.id]);
    await client.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
      VALUES($1,'knowledge_index.preserved','knowledge_base',$2,$3)`, [actorId,String(id),JSON.stringify({versionId:version.id})]);
  }

  async preview(id: number, documentId: number) {
    const result = await this.database.query(`SELECT kb.draft_config,d.chunk_override, b.ordinal, b.block_type AS "blockType",
      b.heading_path AS "headingPath", b.content, b.source_locator AS "sourceLocator"
      FROM knowledge_bases kb JOIN documents d ON d.knowledge_base_id = kb.id
      JOIN document_blocks b ON b.document_id = d.id
      WHERE kb.id = $1 AND d.id = $2 AND kb.archived_at IS NULL AND d.archived_at IS NULL ORDER BY b.ordinal`, [id, documentId]);
    if (!result.rows.length) throw new NotFoundException('Parsed document not found; reprocess legacy documents first');
    const blocks = result.rows.map(({ draft_config, chunk_override, ...block }) => documentBlockSchema.parse(block));
    const config = buildSettings(result.rows[0].draft_config);
    return buildChunks(blocks, { ...config, ...processingSettings({ ...config, ...result.rows[0].chunk_override }) });
  }

  async blocks(id: number, documentId: number) {
    const document = (await this.database.query(`SELECT parser_version AS "parserVersion",parser_warnings AS warnings
      FROM documents WHERE id=$1 AND knowledge_base_id=$2 AND archived_at IS NULL`, [documentId,id])).rows[0];
    if (!document) throw new NotFoundException('Document not found');
    const blocks = (await this.database.query(`SELECT ordinal,block_type AS "blockType",heading_path AS "headingPath",
      content,source_locator AS "sourceLocator" FROM document_blocks WHERE document_id=$1 ORDER BY ordinal`, [documentId])).rows;
    return { ...document, blocks };
  }

  async versions(id: number) {
    return (await this.database.query(`SELECT id::int, status, config, chunk_count AS "chunkCount",
      error_message AS "errorMessage", created_at AS "createdAt", finished_at AS "finishedAt"
      FROM knowledge_index_versions WHERE knowledge_base_id = $1 ORDER BY id DESC`, [id])).rows;
  }

  /** Read the version pointer once so the displayed chunks belong to one index. */
  async documentChunks(id: number, documentId: number) {
    const document = (await this.database.query(`SELECT d.title, d.original_filename AS "originalFilename",
      kb.active_index_version_id::int AS "versionId"
      FROM documents d JOIN knowledge_bases kb ON kb.id=d.knowledge_base_id
      WHERE kb.id=$1 AND d.id=$2`, [id, documentId])).rows[0];
    if (!document) throw new NotFoundException('Document not found');
    if (document.versionId !== null) {
      const chunks = (await this.database.query(`SELECT c.id::int, c.ordinal, c.kind,
        p.ordinal AS "parentOrdinal", c.heading_path AS "headingPath", c.content,
        c.source_locator AS "sourceLocator", c.document_title AS "documentTitle",
        c.original_filename AS "originalFilename"
        FROM index_chunks c JOIN knowledge_index_versions v ON v.id=c.version_id
        LEFT JOIN index_chunks p ON p.id=c.parent_chunk_id AND p.version_id=c.version_id
        WHERE v.knowledge_base_id=$1 AND v.id=$2 AND v.status='ready' AND c.document_id=$3
        ORDER BY c.ordinal`, [id, document.versionId, documentId])).rows;
      return { ...document, indexKind: 'published', chunks };
    }
    const chunks = (await this.database.query(`SELECT id::int, ordinal, heading_path AS "headingPath", content,
      source_start_line AS "sourceStartLine", source_end_line AS "sourceEndLine"
      FROM document_chunks WHERE document_id=$1 ORDER BY ordinal`, [documentId])).rows;
    return { ...document, indexKind: 'live', chunks };
  }

  async build(actorId: number, id: number, activateOnReady = false) {
    return this.database.transaction(async (client) => {
      const kb = (await client.query('SELECT draft_config,index_epoch,active_index_version_id FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!kb) throw new NotFoundException('Active knowledge base not found');
      if ((await client.query("SELECT id FROM knowledge_index_versions WHERE knowledge_base_id=$1 AND status='building'", [id])).rowCount) {
        throw new ConflictException('A build is already queued or running');
      }
      const config = buildSettings(kb.draft_config);
      if (activateOnReady) {
        await assertIndexCompatible(client,id,config);
        kb.index_epoch++;
        await client.query('UPDATE knowledge_bases SET index_epoch=$2,auto_dirty=false,index_error=NULL WHERE id=$1',[id,kb.index_epoch]);
      }
      // A single statement freezes every parsed document and block in one MVCC snapshot.
      const inputs = (await client.query(`SELECT d.id::int AS "documentId", d.status,
        d.title AS "documentTitle", d.original_filename AS "originalFilename",d.chunk_override AS "processingConfig",d.index_revision AS "documentRevision",
        COALESCE(jsonb_agg(jsonb_build_object('ordinal',b.ordinal,'blockType',b.block_type,
          'headingPath',b.heading_path,'content',b.content,'sourceLocator',b.source_locator)
          ORDER BY b.ordinal) FILTER (WHERE b.id IS NOT NULL),'[]') AS blocks
        FROM documents d LEFT JOIN document_blocks b ON b.document_id=d.id
        WHERE d.knowledge_base_id=$1 AND d.archived_at IS NULL AND d.deleted_at IS NULL GROUP BY d.id ORDER BY d.id`, [id])).rows;
      const incomplete = inputs.filter((row) => row.status !== 'ready' || !Array.isArray(row.blocks) || !row.blocks.length);
      if (!inputs.length) throw new ConflictException('请先上传并处理文档，再构建索引');
      if (incomplete.length) {
        throw new ConflictException(`${incomplete.length} active document(s) are not prepared. Wait for processing or use “reprocess all” for legacy documents.`);
      }
      const snapshot = indexInputSchema.parse(inputs.map(({ status, ...input }) => input));
      let profile: unknown = null;
      if (config.indexMode === 'high_quality') {
        profile = (await client.query('SELECT config FROM embedding_profiles WHERE id=$1 AND enabled FOR SHARE', [config.embeddingProfileId])).rows[0]?.config;
        if (!profile) throw new BadRequestException('Enabled embedding profile required');
      }
      const version = (await client.query(`INSERT INTO knowledge_index_versions
        (knowledge_base_id,status,config,embedding_snapshot,input_snapshot,created_by,auto_activate,expected_epoch,base_version_id)
        VALUES ($1,'building',$2,$3,$4,$5,$6,$7,$8) RETURNING id::int`,
      [id, JSON.stringify(config), profile === null ? null : JSON.stringify(profile), JSON.stringify(snapshot), actorId,activateOnReady,kb.index_epoch,kb.active_index_version_id])).rows[0];
      await this.queue.enqueueIndex(client, version.id);
      await client.query(`INSERT INTO audit_logs (actor_admin_id,action,target_type,target_id)
        VALUES ($1,'knowledge_index.build_requested','knowledge_index',$2)`, [actorId, String(version.id)]);
      return version;
    });
  }

  async requestUpdate(actorId:number,id:number) {
    return this.database.transaction(async c=>{
      if(!(await c.query('UPDATE knowledge_bases SET auto_dirty=true,index_error=NULL WHERE id=$1 AND archived_at IS NULL RETURNING id',[id])).rowCount)throw new NotFoundException('Knowledge base not found');
      await this.queue.enqueueAuto(c,id);
      await c.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id) VALUES($1,'knowledge_index.retry_requested','knowledge_base',$2)",[actorId,String(id)]);
      return {queued:true};
    });
  }

  async activate(actorId: number, id: number, versionId: number) {
    return this.database.transaction(async (client) => {
      const kb = (await client.query('SELECT id FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR UPDATE',[id])).rows[0];
      const version = (await client.query("SELECT config,embedding_snapshot FROM knowledge_index_versions WHERE id=$1 AND knowledge_base_id=$2 AND status='ready'",[versionId,id])).rows[0];
      if (!kb || !version) throw new ConflictException('Only a ready version belonging to an active knowledge base can be activated');
      await assertIndexCompatible(client,id,buildSettings(version.config),version.embedding_snapshot);
      const result = await client.query(`UPDATE knowledge_bases kb SET active_index_version_id=v.id, enabled_for_chat=true, updated_at=now()
        FROM knowledge_index_versions v WHERE kb.id=$1 AND kb.archived_at IS NULL
        AND v.id=$2 AND v.knowledge_base_id=kb.id AND v.status='ready' RETURNING kb.id::int`, [id, versionId]);
      if (!result.rowCount) throw new ConflictException('Only a ready version belonging to an active knowledge base can be activated');
      await client.query('UPDATE knowledge_bases SET index_epoch=index_epoch+1,auto_dirty=false,index_error=NULL WHERE id=$1',[id]);
      await client.query('UPDATE documents SET index_pending=false WHERE knowledge_base_id=$1',[id]);
      await client.query(`INSERT INTO audit_logs (actor_admin_id,action,target_type,target_id,details)
        VALUES ($1,'knowledge_index.activated','knowledge_base',$2,$3)`, [actorId, String(id), JSON.stringify({ versionId })]);
      return { id, activeIndexVersionId: versionId };
    });
  }
}
