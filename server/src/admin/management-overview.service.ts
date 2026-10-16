import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

/** Small, permission-scoped operational overview. No payloads or debug state. */
@Injectable()
export class ManagementOverviewService {
  constructor(private readonly db: DatabaseService) {}

  async overview(permissionCodes: string[]) {
    const can = (...codes: string[]) => codes.some(code => permissionCodes.includes(code));
    const generatedAt = new Date().toISOString();
    const since = new Date(Date.parse(generatedAt) - 86400000).toISOString();
    const [agents, executions, knowledge] = await Promise.all([
      can('agent_config.read', 'agent_config.manage') ? this.agents() : null,
      can('conversations.read') ? this.executions(since, generatedAt, can('agent_config.read', 'agent_config.manage')) : null,
      can('documents.read', 'knowledge_bases.manage') ? this.knowledge() : null,
    ]);
    return { generatedAt, period: { since, until: generatedAt }, agents, executions, knowledge };
  }

  private async agents() {
    const query = `FROM agent_resources r
      LEFT JOIN agent_resource_versions current ON current.id=r.current_version_id
      LEFT JOIN LATERAL (SELECT display_name,config,updated_at FROM agent_resource_versions
        WHERE resource_id=r.id AND status='draft' ORDER BY version DESC LIMIT 1) draft ON true
      WHERE r.kind='agent' AND r.archived_at IS NULL AND r.deleted_at IS NULL`;
    const [totals, recent] = await Promise.all([
      this.db.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE current.id IS NOT NULL)::int AS published,
        count(*) FILTER (WHERE current.id IS NULL)::int AS unpublished,
        count(*) FILTER (WHERE current.id IS NOT NULL AND draft.config IS NOT NULL
          AND (draft.config IS DISTINCT FROM current.config OR draft.display_name IS DISTINCT FROM current.display_name))::int AS changed ${query}`),
      this.db.query(`SELECT r.id::int,COALESCE(current.display_name,draft.display_name,r.name) AS name,
        current.id IS NOT NULL AS published,
        current.id IS NOT NULL AND draft.config IS NOT NULL
          AND (draft.config IS DISTINCT FROM current.config OR draft.display_name IS DISTINCT FROM current.display_name) AS changed,
        GREATEST(r.updated_at,draft.updated_at,current.updated_at) AS "updatedAt"
        ${query} ORDER BY "updatedAt" DESC,r.id DESC LIMIT 5`),
    ]);
    return { ...totals.rows[0], recent: recent.rows };
  }

  private async executions(since: string, until: string, namesAllowed: boolean) {
    const [totals, recent] = await Promise.all([
      this.db.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status='failed')::int AS failed,
        count(*) FILTER (WHERE status='completed')::int AS completed
        FROM chat_traces WHERE kind='answer' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`, [since, until]),
      this.db.query(`SELECT t.id,t.status,t.error_code AS "errorCode",t.created_at AS "createdAt",
        t.context_snapshot->'agentComposition'->>'agentId' AS "agentId"${namesAllowed ? ',r.name AS "agentName"' : ''}
        FROM chat_traces t ${namesAllowed ? "LEFT JOIN agent_resources r ON r.id::text=t.context_snapshot->'agentComposition'->>'agentId' AND r.kind='agent'" : ''}
        WHERE t.kind='answer' AND t.created_at >= $1::timestamptz AND t.created_at < $2::timestamptz
        ORDER BY t.created_at DESC,t.id DESC LIMIT 5`, [since, until]),
    ]);
    return { ...totals.rows[0], recent: recent.rows };
  }

  private async knowledge() {
    const [totals, documents, indexes] = await Promise.all([
      this.db.query(`WITH files AS (SELECT d.status,d.index_pending FROM documents d
        JOIN knowledge_bases kb ON kb.id=d.knowledge_base_id
        WHERE d.archived_at IS NULL AND d.deleted_at IS NULL AND kb.archived_at IS NULL)
        SELECT count(*) FILTER (WHERE status IN ('pending','queued','processing','extracted'))::int AS processing,
        count(*) FILTER (WHERE status='failed')::int AS failed,
        count(*) FILTER (WHERE index_pending)::int AS "pendingIndex" FROM files`),
      this.db.query(`SELECT d.id::int,d.title,kb.id::int AS "baseId",kb.name AS "baseName",d.updated_at AS "updatedAt"
        FROM documents d JOIN knowledge_bases kb ON kb.id=d.knowledge_base_id
        WHERE d.status='failed' AND d.archived_at IS NULL AND d.deleted_at IS NULL AND kb.archived_at IS NULL
        ORDER BY d.updated_at DESC,d.id DESC LIMIT 5`),
      this.db.query(`SELECT kb.id::int AS "baseId",kb.name AS "baseName",v.id::int AS "versionId",v.created_at AS "createdAt"
        FROM knowledge_bases kb JOIN LATERAL (SELECT id,status,created_at FROM knowledge_index_versions
          WHERE knowledge_base_id=kb.id ORDER BY id DESC LIMIT 1) v ON true
        WHERE kb.archived_at IS NULL AND v.status='failed'
        ORDER BY v.created_at DESC,kb.id DESC LIMIT 5`),
    ]);
    return { ...totals.rows[0], documentFailures: documents.rows, indexFailures: indexes.rows };
  }
}
