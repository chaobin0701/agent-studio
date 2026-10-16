import { currentWorkspaceId } from '../workspaces/workspace-context';
import { BadRequestException, ConflictException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { DatabaseService } from '../database.service';
import { DocumentQueueService } from './document-queue.service';
import { documentsDir, documentPath } from './document-storage';
import { AppConfigService } from '../config/config.service';
import { z } from 'zod';
import { processingSettings } from './knowledge-config';

const chunkOverrideSchema = z.object({
  chunkMode: z.enum(['general', 'parent_child']).default('general'),
  separatorMode: z.enum(['auto', 'heading_paragraph', 'fixed']).default('auto'),
  preserveHeading: z.boolean().default(true),
  chunkChars: z.number().int().min(200).max(4000),
  overlapChars: z.number().int().min(0).max(400),
  parentChars: z.number().int().min(500).max(6000).optional(),
  childChars: z.number().int().min(100).max(2000).optional(),
  childOverlapChars: z.number().int().min(0).max(200).optional(),
}).strict().refine(value => value.overlapChars < value.chunkChars, 'Overlap must be smaller than chunk size');

const MAX_BYTES = 2 * 1024 * 1024;

@Injectable()
export class DocumentService {
  constructor(private readonly database: DatabaseService, private readonly queue: DocumentQueueService, private readonly config: AppConfigService) {}

  async uploadBatch(actor: number, baseId: number, files: Express.Multer.File[]) {
    if(!files?.length || files.length>20)throw new BadRequestException('每批选择 1–20 个文件');
    const results: {id?:number;name:string;ok:boolean;message?:string}[]=[];
    for(const file of files) {
      try { const result=await this.upload(actor,file,undefined,baseId,undefined,true);results.push({id:result.id,name:file.originalname,ok:true}); }
      catch(error) { results.push({name:file.originalname,ok:false,message:error instanceof BadRequestException?error.message:'文件保存失败，请重试'}); }
    }
    await this.database.transaction(async c=>{
      for(const result of results.filter(r=>r.ok)) {
        await c.query("UPDATE documents SET status='queued' WHERE id=$1 AND knowledge_base_id=$2",[result.id,baseId]);
        await this.queue.enqueue(c,result.id!);
      }
    });
    return {files:results};
  }

  async rebuildSelected(actor:number,baseId:number,input:unknown) {
    const value=z.object({documentIds:z.array(z.number().int().positive()).min(1).max(100)}).strict().safeParse(input);
    if(!value.success)throw new BadRequestException('请选择文档');
    return this.database.transaction(async c=>{
      const base=(await c.query('SELECT draft_config,index_epoch FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR SHARE',[baseId])).rows[0];
      if(!base)throw new NotFoundException('Knowledge base not found');
      const ids=[...new Set(value.data.documentIds)];
      const docs=(await c.query("SELECT id::int FROM documents WHERE id=ANY($1::bigint[]) AND knowledge_base_id=$2 AND archived_at IS NULL AND deleted_at IS NULL AND status IN ('ready','failed','pending','extracted') FOR UPDATE",[ids,baseId])).rows;
      if(docs.length!==ids.length)throw new ConflictException('部分文档不可重新处理，或正在处理中');
      await c.query("UPDATE documents SET status='queued',index_pending=true,index_revision=index_revision+1,chunk_override=$2,processing_epoch=$3,error_message=NULL WHERE id=ANY($1::bigint[])",[ids,JSON.stringify(processingSettings(base.draft_config)),base.index_epoch]);
      for(const id of ids)await this.queue.enqueue(c,id);
      await c.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'documents.rebuild_selected','knowledge_base',$2,$3)",[actor,String(baseId),JSON.stringify({documentIds:ids})]);
      return {queued:ids.length};
    });
  }

  async recycle(actor:number,id:number,baseId:number,restore=false) {
    return this.database.transaction(async c=>{
      const doc=(await c.query(`UPDATE documents SET deleted_at=${restore?'NULL':'now()'},updated_at=now()
        WHERE id=$1 AND knowledge_base_id=$2 AND deleted_at IS ${restore?'NOT NULL':'NULL'} RETURNING id::int,status,archived_at`,[id,baseId])).rows[0];
      if(!doc)throw new NotFoundException('Document not found');
      if(restore && !doc.archived_at && !(await c.query('SELECT 1 FROM index_chunks c JOIN knowledge_bases k ON k.active_index_version_id=c.version_id WHERE k.id=$1 AND c.document_id=$2',[baseId,id])).rowCount) {
        await c.query('UPDATE documents SET index_pending=true,processing_epoch=(SELECT index_epoch FROM knowledge_bases WHERE id=$2) WHERE id=$1',[id,baseId]);
        await c.query('UPDATE knowledge_bases SET auto_dirty=true WHERE id=$1',[baseId]);
        await this.queue.enqueueAuto(c,baseId);
      }
      await c.query("INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id) VALUES($1,$2,'document',$3)",[actor,restore?'document.restored':'document.deleted',String(id)]);
      return {id,deleted:!restore};
    });
  }

  async indexStatus(id:number,baseId:number) {
    await this.get(id,baseId);
    const history=(await this.database.query(`SELECT v.id::int,v.created_at AS "createdAt",v.config,
      v.id=k.active_index_version_id AS active FROM knowledge_index_versions v JOIN knowledge_bases k ON k.id=v.knowledge_base_id
      WHERE v.knowledge_base_id=$1 AND v.status='ready' AND EXISTS(SELECT 1 FROM index_chunks c WHERE c.version_id=v.id AND c.document_id=$2) ORDER BY v.id`,[baseId,id])).rows;
    return {firstIndexedVersionId:history[0]?.id??null,versions:history};
  }

  async upload(actorId: number, file: Express.Multer.File | undefined, rawTitle: string | undefined, knowledgeBaseId?: number, rawProcessingConfig?: string, deferProcessing = false) {
    if (!file) throw new BadRequestException('A document file is required');
    const filename = basename(file.originalname).normalize('NFC');
    const extension = extname(filename).toLowerCase();
    if (!['.md', '.markdown', '.docx', '.pdf'].includes(extension)) {
      throw new BadRequestException('Only Markdown, DOCX, and PDF files are supported');
    }
    if (!filename || filename.length > 255 || file.size === 0 || file.size > MAX_BYTES) {
      throw new BadRequestException('Invalid filename or file size');
    }
    if (extension === '.md' || extension === '.markdown') {
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
      } catch {
        throw new BadRequestException('Markdown file must be UTF-8 text');
      }
      if (!content.trim() || content.includes('\0')) throw new BadRequestException('Markdown content is empty or invalid');
    } else if (extension === '.pdf' && file.buffer.subarray(0, 5).toString() !== '%PDF-') {
      throw new BadRequestException('Invalid PDF file');
    } else if (extension === '.docx' && file.buffer.subarray(0, 4).toString('hex') !== '504b0304') {
      throw new BadRequestException('Invalid DOCX file');
    }

    let processingConfig: z.infer<typeof chunkOverrideSchema> | null = null;
    if (rawProcessingConfig) {
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(rawProcessingConfig); } catch { throw new BadRequestException('Invalid processing configuration'); }
      const parsedConfig = chunkOverrideSchema.safeParse(parsedBody);
      if (!parsedConfig.success) throw new BadRequestException('Invalid processing configuration');
      processingConfig = parsedConfig.data;
    }
    const title = rawTitle?.trim() || filename.replace(/\.(md|markdown|docx|pdf)$/i, '');
    if (title.length > 200) throw new BadRequestException('Title is too long');
    const storageKey = `${currentWorkspaceId()}/${randomUUID()}.${extension === '.markdown' ? 'md' : extension.slice(1)}`;
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    await mkdir(documentsDir(this.config), { recursive: true });
    await writeFile(documentPath(storageKey, this.config), file.buffer, { flag: 'wx' });

    try {
      return await this.database.transaction(async (client) => {
        const base = await client.query<{ id: string; draft_config: unknown; index_epoch:number }>(`SELECT id,draft_config,index_epoch FROM knowledge_bases
          WHERE id = COALESCE($1::bigint, (SELECT id FROM knowledge_bases WHERE is_default))
          AND archived_at IS NULL FOR SHARE`, [knowledgeBaseId ?? null]);
        if (!base.rows[0]) throw new NotFoundException('Active knowledge base not found');
        const documentProcessing = { ...processingSettings(base.rows[0].draft_config), ...processingConfig };
        processingSettings(documentProcessing);
        const created = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO documents (title, original_filename, storage_key, sha256, byte_size, uploaded_by, knowledge_base_id, status, chunk_override,index_pending,processing_epoch)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,true,COALESCE($10,0)) RETURNING id, created_at`,
          [title, filename, storageKey, sha256, file.size, actorId, base.rows[0].id, deferProcessing ? 'pending' : 'queued', JSON.stringify(documentProcessing),base.rows[0].index_epoch],
        );
        const id = Number(created.rows[0].id);
        if (!deferProcessing) await this.queue.enqueue(client, id);
        await client.query(
          `INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, details)
           VALUES ($1, 'document.uploaded', 'document', $2, $3)`,
          [actorId, String(id), JSON.stringify({ filename, byteSize: file.size })],
        );
        return { id, title, originalFilename: filename, status: deferProcessing ? 'pending' : 'queued', createdAt: created.rows[0].created_at };
      });
    } catch (error) {
      // A lost connection during COMMIT is ambiguous: the row may already exist.
      // Keep the file if we cannot prove the transaction rolled back.
      try {
        const found = await this.database.query('SELECT 1 FROM documents WHERE storage_key = $1', [storageKey]);
        if (!found.rows[0]) await unlink(documentPath(storageKey, this.config));
      } catch {
        // Leave a possible orphan for later reconciliation rather than break a committed document.
      }
      throw error;
    }
  }

  async list(limit: number, offset: number, knowledgeBaseId?: number, trash = false, state: 'active' | 'archived' | 'all' = 'all', ids?: number[]) {
    const result = await this.database.query(
      `SELECT id::int, title, original_filename AS "originalFilename", byte_size AS "byteSize",
              uploaded_by::int AS "uploadedBy", status, error_message AS "errorMessage",
              parser_version AS "parserVersion", source_type AS "sourceType", enabled_for_retrieval AS "enabledForRetrieval",
              char_length(extracted_text)::int AS "characterCount",
              (SELECT count(*)::int FROM document_chunks chunk WHERE chunk.document_id=documents.id) AS "chunkCount",
              chunk_override AS "chunkOverride",
              EXISTS(SELECT 1 FROM index_chunks c JOIN knowledge_bases k ON k.active_index_version_id=c.version_id WHERE c.document_id=documents.id AND k.id=documents.knowledge_base_id) AS "inCurrentIndex",
              COALESCE((SELECT (x->>'documentRevision')::int FROM knowledge_bases k JOIN knowledge_index_versions v ON v.id=k.active_index_version_id,
                jsonb_array_elements(v.input_snapshot) x WHERE k.id=documents.knowledge_base_id AND (x->>'documentId')::bigint=documents.id LIMIT 1),1) AS "indexedRevision",
              archived_at AS "archivedAt",deleted_at AS "deletedAt",index_pending AS "indexPending",index_revision AS "indexRevision", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM documents WHERE knowledge_base_id = COALESCE($3::bigint, (SELECT id FROM knowledge_bases WHERE is_default))
       AND (deleted_at IS NOT NULL)=$4
       AND ($6::bigint[] IS NULL OR id=ANY($6))
       AND ($4 OR $5::text='all' OR ($5='archived' AND archived_at IS NOT NULL) OR ($5='active' AND archived_at IS NULL))
       ORDER BY id DESC LIMIT $1 OFFSET $2`, [limit, offset, knowledgeBaseId ?? null,trash,state,ids ?? null],
    );
    return result.rows;
  }

  async get(id: number, knowledgeBaseId?: number) {
    const result = await this.database.query(
      `SELECT id::int, title, original_filename AS "originalFilename", sha256,
              byte_size AS "byteSize", uploaded_by::int AS "uploadedBy", status,
              extracted_text AS "extractedText", error_message AS "errorMessage", enabled_for_retrieval AS "enabledForRetrieval",
              (SELECT count(*)::int FROM document_chunks WHERE document_id = documents.id) AS "chunkCount",
              chunk_override AS "chunkOverride",
              EXISTS(SELECT 1 FROM index_chunks c JOIN knowledge_bases k ON k.active_index_version_id=c.version_id WHERE c.document_id=documents.id AND k.id=documents.knowledge_base_id) AS "inCurrentIndex",
              COALESCE((SELECT (x->>'documentRevision')::int FROM knowledge_bases k JOIN knowledge_index_versions v ON v.id=k.active_index_version_id,
                jsonb_array_elements(v.input_snapshot) x WHERE k.id=documents.knowledge_base_id AND (x->>'documentId')::bigint=documents.id LIMIT 1),1) AS "indexedRevision",
              archived_at AS "archivedAt",deleted_at AS "deletedAt",index_pending AS "indexPending",index_revision AS "indexRevision", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM documents WHERE id = $1 AND knowledge_base_id = COALESCE($2::bigint, (SELECT id FROM knowledge_bases WHERE is_default))`, [id, knowledgeBaseId ?? null],
    );
    if (!result.rows[0]) throw new NotFoundException('Document not found');
    return result.rows[0];
  }

  async download(id: number, knowledgeBaseId: number) {
    const result = await this.database.query<{ storage_key: string; original_filename: string; inline_content: string | null }>(
      `SELECT storage_key,original_filename,inline_content FROM documents WHERE id=$1 AND knowledge_base_id=$2 AND source_type='file'`, [id,knowledgeBaseId]);
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Original file not found');
    let bytes: Buffer;
    try { bytes=row.inline_content == null ? await readFile(documentPath(row.storage_key,this.config)) : Buffer.from(row.inline_content); }
    catch { throw new NotFoundException('Original file unavailable'); }
    return new StreamableFile(bytes, { type:'application/octet-stream',
      disposition:`attachment; filename*=UTF-8''${encodeURIComponent(row.original_filename).replace(/'/g,'%27')}` });
  }

  async archive(actorId: number, id: number, knowledgeBaseId?: number) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE documents SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL AND deleted_at IS NULL
         AND knowledge_base_id = COALESCE($2::bigint, (SELECT id FROM knowledge_bases WHERE is_default)) RETURNING id`, [id, knowledgeBaseId ?? null],
      );
      if (!result.rows[0]) throw new NotFoundException('Active document not found');
      await client.query(
        `INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id)
         VALUES ($1, 'document.archived', 'document', $2)`, [actorId, String(id)],
      );
      return { id, archived: true };
    });
  }

  async unarchive(actorId: number, id: number, knowledgeBaseId?: number) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE documents SET archived_at = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL
         AND knowledge_base_id = COALESCE($2::bigint, (SELECT id FROM knowledge_bases WHERE is_default)) RETURNING id`, [id, knowledgeBaseId ?? null],
      );
      if (!result.rows[0]) throw new NotFoundException('Archived document not found');
      const indexed=(await client.query('SELECT 1 FROM index_chunks c JOIN knowledge_bases k ON k.active_index_version_id=c.version_id JOIN documents d ON d.id=c.document_id WHERE d.id=$1 AND d.deleted_at IS NULL',[id])).rowCount;
      if(!indexed){
        await client.query('UPDATE documents SET index_pending=true,processing_epoch=(SELECT index_epoch FROM knowledge_bases WHERE id=documents.knowledge_base_id) WHERE id=$1 AND deleted_at IS NULL',[id]);
        const base=(await client.query('UPDATE knowledge_bases SET auto_dirty=true WHERE id=(SELECT knowledge_base_id FROM documents WHERE id=$1 AND deleted_at IS NULL) RETURNING id::int',[id])).rows[0];
        if(base)await this.queue.enqueueAuto(client,base.id);
      }
      await client.query(`INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id)
        VALUES ($1, 'document.unarchived', 'document', $2)`, [actorId, String(id)]);
      return { id, archived: false };
    });
  }

  async setEnabled(actorId: number, id: number, enabled: boolean, knowledgeBaseId?: number) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE documents SET enabled_for_retrieval = $3, updated_at = now() WHERE id = $1
         AND archived_at IS NULL AND knowledge_base_id = COALESCE($2::bigint, (SELECT id FROM knowledge_bases WHERE is_default)) RETURNING id`, [id, knowledgeBaseId ?? null, enabled],
      );
      if (!result.rows[0]) throw new NotFoundException('Active document not found');
      await client.query(`INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, details)
        VALUES ($1, 'document.retrieval_status_changed', 'document', $2, $3)`, [actorId, String(id), JSON.stringify({ enabled })]);
      return { id, enabledForRetrieval: enabled };
    });
  }

  async retry(actorId: number, id: number, knowledgeBaseId?: number) {
    return this.scheduleReprocess(actorId, id, true, knowledgeBaseId);
  }

  async reprocess(actorId: number, id: number, knowledgeBaseId?: number, chunkOverride?: unknown) {
    const parsed = chunkOverride === undefined || chunkOverride === null ? null : chunkOverrideSchema.safeParse(chunkOverride);
    if (parsed && !parsed.success) throw new BadRequestException('Invalid document chunk settings');
    return this.scheduleReprocess(actorId, id, false, knowledgeBaseId, parsed?.success ? parsed.data : null);
  }

  async reprocessAll(actorId: number, knowledgeBaseId: number) {
    return this.database.transaction(async (client) => {
      const base = await client.query(`SELECT id,draft_config FROM knowledge_bases WHERE id=$1 AND archived_at IS NULL FOR SHARE`, [knowledgeBaseId]);
      if (!base.rowCount) throw new NotFoundException('Active knowledge base not found');
      const queued = await client.query<{ id: number }>(`UPDATE documents AS document
        SET status='queued', error_message=NULL, chunk_override=$2,index_pending=true,index_revision=index_revision+1,processing_epoch=(SELECT index_epoch FROM knowledge_bases WHERE id=$1),updated_at=now()
        WHERE knowledge_base_id=$1 AND archived_at IS NULL AND deleted_at IS NULL AND source_type='file'
          AND status IN ('pending','ready','failed','extracted')
        RETURNING id::int`, [knowledgeBaseId,JSON.stringify(processingSettings(base.rows[0].draft_config))]);
      for (const document of queued.rows) await this.queue.enqueue(client, document.id);
      await client.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details)
        VALUES($1,'document.reprocess_all','knowledge_base',$2,$3)`, [actorId,String(knowledgeBaseId),JSON.stringify({ count: queued.rows.length })]);
      return { queued: queued.rows.length };
    });
  }

  async listChunks(id: number, knowledgeBaseId?: number) {
    await this.get(id, knowledgeBaseId);
    const result = await this.database.query(
      `SELECT id::int, ordinal, heading_path AS "headingPath", content,
              source_start_line AS "sourceStartLine", source_end_line AS "sourceEndLine"
       FROM document_chunks WHERE document_id = $1 ORDER BY ordinal`, [id],
    );
    return result.rows;
  }

  private async scheduleReprocess(actorId: number, id: number, onlyFailed: boolean, knowledgeBaseId?: number, chunkOverride?: { chunkChars: number; overlapChars: number } | null) {
    return this.database.transaction(async (client) => {
      const row = await client.query<{ status: string; archived_at: Date | null; source_type: string; draft_config: unknown }>(
        `SELECT status, archived_at,deleted_at, source_type,(SELECT draft_config FROM knowledge_bases WHERE id=documents.knowledge_base_id) AS draft_config FROM documents WHERE id = $1
         AND knowledge_base_id = COALESCE($2::bigint, (SELECT id FROM knowledge_bases WHERE is_default)) FOR UPDATE`, [id, knowledgeBaseId ?? null],
      );
      if (!row.rows[0]) throw new NotFoundException('Document not found');
      if (row.rows[0].source_type === 'faq' || (row.rows[0] as any).deleted_at || row.rows[0].archived_at || (onlyFailed
        ? row.rows[0].status !== 'failed'
        : !['pending', 'failed', 'extracted', 'ready'].includes(row.rows[0].status))) {
        throw new ConflictException('Document cannot be reprocessed in its current state');
      }
      await client.query(
        "UPDATE documents SET status = 'queued', error_message = NULL,index_revision=index_revision+1,index_pending=true,processing_epoch=(SELECT k.index_epoch FROM knowledge_bases k WHERE k.id=documents.knowledge_base_id), updated_at = now() WHERE id = $1", [id],
      );
      if (chunkOverride !== undefined) {
        const settings = { ...processingSettings(row.rows[0].draft_config), ...chunkOverride };
        processingSettings(settings);
        await client.query('UPDATE documents SET chunk_override=$2::jsonb WHERE id=$1', [id,JSON.stringify(settings)]);
      }
      await this.queue.enqueue(client, id);
      await client.query(
        `INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id)
         VALUES ($1, $2, 'document', $3)`, [actorId, onlyFailed ? 'document.retried' : 'document.reprocessed', String(id)],
      );
      return { id, status: 'queued' };
    });
  }
}
