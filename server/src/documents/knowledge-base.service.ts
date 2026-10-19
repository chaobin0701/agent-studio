import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { knowledgeConfigSchema,buildSettings, processingSettings, indexSettings, processingConfigSchema,indexConfigSchema } from './knowledge-config';

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  enabledForChat: z.boolean().default(true),
  draftConfig: knowledgeConfigSchema.optional(),
  processingConfig: processingConfigSchema.optional(),
  indexConfig: indexConfigSchema.optional(),
}).strict();
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  enabledForChat: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Empty update');
const columns = `id::int, name, description, is_default AS "isDefault", enabled_for_chat AS "enabledForChat",
  archived_at AS "archivedAt", created_at AS "createdAt", updated_at AS "updatedAt",
  draft_config AS "draftConfig",index_error AS "indexError", auto_dirty AS "indexUpdating", active_index_version_id::int AS "activeIndexVersionId"`;
const withSettings = (row: any) => ({ ...row,draftConfig:buildSettings(row.draftConfig), processingConfig: processingSettings(row.draftConfig),
  indexConfig: indexSettings(row.draftConfig) });

@Injectable()
export class KnowledgeBaseService {
  constructor(private readonly database: DatabaseService) {}

  async list() {
    return (await this.database.query(`SELECT ${columns},
      (SELECT count(*)::int FROM documents document
        WHERE document.knowledge_base_id = knowledge_bases.id AND document.archived_at IS NULL AND document.deleted_at IS NULL AND document.source_type='file') AS "documentCount",
      (SELECT count(*)::int FROM documents document
        WHERE document.knowledge_base_id = knowledge_bases.id AND document.archived_at IS NULL AND document.deleted_at IS NULL
          AND document.source_type='file' AND document.status='ready' AND document.enabled_for_retrieval) AS "readyDocumentCount"
      FROM knowledge_bases ORDER BY updated_at DESC, id DESC`)).rows.map(withSettings);
  }

  async get(id: number) {
    const result = await this.database.query(`SELECT ${columns},
      (SELECT config FROM knowledge_index_versions WHERE id=knowledge_bases.active_index_version_id AND status='ready') AS "activeIndexConfig"
      FROM knowledge_bases WHERE id = $1`, [id]);
    if (!result.rows[0]) throw new NotFoundException('Knowledge base not found');
    return withSettings(result.rows[0]);
  }

  async create(actorId: number, input: unknown) {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid knowledge base configuration');
    const value = parsed.data;
    const draft = {...processingSettings(value.draftConfig),...indexSettings(value.draftConfig),...value.processingConfig,...value.indexConfig};
    return this.database.transaction(async (client) => {
      if (draft.embeddingProfileId) {
        const profile = await client.query('SELECT id FROM embedding_profiles WHERE id=$1 AND enabled FOR SHARE', [draft.embeddingProfileId]);
        if (!profile.rowCount) throw new BadRequestException('Enabled embedding profile required');
      }
      const row = (await client.query(`INSERT INTO knowledge_bases (name, description, enabled_for_chat, draft_config)
        VALUES ($1, $2, $3, $4::jsonb) RETURNING ${columns}`, [value.name, value.description, value.enabledForChat,JSON.stringify(draft)])).rows[0];
      await client.query(`INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id)
        VALUES ($1, 'knowledge_base.created', 'knowledge_base', $2)`, [actorId, String(row.id)]);
      return withSettings(row);
    });
  }

  async update(actorId: number, id: number, input: unknown) {
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid knowledge base configuration');
    const value = parsed.data;
    return this.database.transaction(async (client) => {
      const row = (await client.query(`UPDATE knowledge_bases SET name = COALESCE($2, name),
        description = COALESCE($3, description), enabled_for_chat = COALESCE($4, enabled_for_chat), updated_at = now()
        WHERE id = $1 AND archived_at IS NULL RETURNING ${columns}`,
      [id, value.name ?? null, value.description ?? null, value.enabledForChat ?? null])).rows[0];
      if (!row) throw new NotFoundException('Active knowledge base not found');
      await client.query(`INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id, details)
        VALUES ($1, 'knowledge_base.updated', 'knowledge_base', $2, $3)`, [actorId, String(id), JSON.stringify(value)]);
      return row;
    });
  }

  async archive(actorId: number, id: number) {
    return this.database.transaction(async (client) => {
      const current = (await client.query('SELECT id FROM knowledge_bases WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!current) throw new NotFoundException('Active knowledge base not found');
      await client.query('UPDATE knowledge_bases SET archived_at = now(), enabled_for_chat = false, updated_at = now() WHERE id = $1', [id]);
      await client.query(`INSERT INTO audit_logs (actor_admin_id, action, target_type, target_id)
        VALUES ($1, 'knowledge_base.archived', 'knowledge_base', $2)`, [actorId, String(id)]);
      return { id, archived: true };
    });
  }

  async unarchive(actorId: number, id: number) {
    return this.database.transaction(async client => {
      const row = (await client.query(`UPDATE knowledge_bases
        SET archived_at=NULL,enabled_for_chat=false,updated_at=now()
        WHERE id=$1 AND archived_at IS NOT NULL RETURNING id::int`, [id])).rows[0];
      if (!row) throw new NotFoundException('Archived knowledge base not found');
      await client.query(`INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id)
        VALUES($1,'knowledge_base.unarchived','knowledge_base',$2)`, [actorId, String(id)]);
      return { id, archived: false };
    });
  }
}
