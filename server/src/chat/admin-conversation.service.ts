import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export type ConversationStatusFilter = 'all' | 'answered' | 'refused' | 'failed' | 'active';
const CLIENT_TYPES = new Set(['all', 'browser', 'mobile', 'wechat', 'feishu', 'api']);

@Injectable()
export class AdminConversationService {
  constructor(private readonly database: DatabaseService) {}

  async list(limit: number, offset: number, query = '', status: string = 'all', visitorId = '', device = 'all', since: string | null = null, applicationId = '') {
    const filter = this.normalizeStatus(status);
    if (!CLIENT_TYPES.has(device)) throw new BadRequestException('Invalid conversation device filter');
    if (since && Number.isNaN(new Date(since).getTime())) throw new BadRequestException('Invalid conversation time filter');
    if (applicationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(applicationId)) throw new BadRequestException('Invalid application ID');
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const safeOffset = Math.max(0, offset);
    const search = `%${query.trim()}%`;
    const result = await this.database.query(
      `WITH message_stats AS (
         SELECT conversation_id, count(*)::int AS "messageCount",
                count(*) FILTER (WHERE role = 'user')::int AS "turnCount"
         FROM conversation_messages GROUP BY conversation_id
       ), latest_trace AS (
         SELECT DISTINCT ON (conversation_id) conversation_id, id AS "traceId",
                question, status, refused, created_at AS "traceCreatedAt"
         FROM chat_traces WHERE kind = 'answer'
         ORDER BY conversation_id, created_at DESC
       )
       SELECT c.id, c.title, c.updated_at AS "updatedAt", c.created_at AS "createdAt",
              c.visitor_session_id AS "visitorSessionId",
              c.application_id AS "applicationId", app.name AS "applicationName",
              vs.client_type AS "clientType",
              c.busy_until AS "busyUntil",
              COALESCE(ms."messageCount", 0) AS "messageCount",
              COALESCE(ms."turnCount", 0) AS "turnCount",
              lt.question AS "lastQuestion", lt.status AS "lastStatus", lt.refused AS "lastRefused",
              lt."traceId" AS "lastTraceId",
              EXISTS (SELECT 1 FROM chat_traces t WHERE t.conversation_id = c.id AND t.status = 'failed') AS "hasFailed",
              EXISTS (SELECT 1 FROM chat_traces t WHERE t.conversation_id = c.id AND t.refused = true) AS "hasRefused"
       FROM conversations c
       JOIN visitor_sessions vs ON vs.id = c.visitor_session_id
       JOIN integration_apps app ON app.id = c.application_id
       LEFT JOIN message_stats ms ON ms.conversation_id = c.id
       LEFT JOIN latest_trace lt ON lt.conversation_id = c.id
       WHERE ($1 = '%%' OR c.id::text ILIKE $1 OR c.title ILIKE $1 OR COALESCE(lt.question, '') ILIKE $1)
         AND COALESCE(ms."messageCount", 0) > 0
         AND ($3 = '' OR c.visitor_session_id::text = $3)
         AND ($4 = 'all' OR vs.client_type = $4)
         AND ($5::timestamptz IS NULL OR c.updated_at >= $5::timestamptz)
         AND ($8 = '' OR c.application_id::text = $8)
         AND ($2 = 'all'
           OR ($2 = 'answered' AND lt.status = 'completed' AND COALESCE(lt.refused, false) = false)
           OR ($2 = 'refused' AND lt.refused = true)
           OR ($2 = 'failed' AND (lt.status = 'failed' OR EXISTS (SELECT 1 FROM chat_traces t2 WHERE t2.conversation_id = c.id AND t2.status = 'failed')))
           OR ($2 = 'active' AND c.busy_until IS NOT NULL AND c.busy_until > now()))
       ORDER BY c.updated_at DESC
       LIMIT $6 OFFSET $7`, [search, filter, visitorId, device, since, safeLimit + 1, safeOffset, applicationId],
    );
    const hasMore = result.rows.length > safeLimit;
    const filters = await this.database.query<{ visitorId: string; conversationCount: number; clientType: string }>(
      `SELECT c.visitor_session_id::text AS "visitorId", count(*)::int AS "conversationCount", vs.client_type AS "clientType"
       FROM conversations c JOIN visitor_sessions vs ON vs.id = c.visitor_session_id
       WHERE EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id)
       GROUP BY c.visitor_session_id, vs.client_type ORDER BY max(c.updated_at) DESC LIMIT 100`,
    );
    const applications = await this.database.query('SELECT id, name FROM integration_apps ORDER BY is_internal DESC, name LIMIT 200');
    return { items: result.rows.slice(0, safeLimit), filters: filters.rows, applications: applications.rows, pagination: { limit: safeLimit, offset: safeOffset, hasMore } };
  }

  async detail(id: string) {
    const conversation = await this.database.query(
      `SELECT c.id, c.visitor_session_id AS "visitorSessionId", c.title, c.summary,
              c.application_id AS "applicationId", app.name AS "applicationName",
              c.busy_until AS "busyUntil", c.created_at AS "createdAt", c.updated_at AS "updatedAt"
       FROM conversations c JOIN integration_apps app ON app.id=c.application_id WHERE c.id = $1`, [id],
    );
    if (!conversation.rows[0]) throw new NotFoundException('Conversation not found');
    const [messages, runs, traces] = await Promise.all([
      this.database.query(
        `SELECT id::int, role, content, refused, citations, request_context AS context, tool_steps AS "toolSteps",
                progress_events AS "progressEvents", created_at AS "createdAt"
         FROM conversation_messages WHERE conversation_id = $1 ORDER BY id ASC`, [id]),
      this.database.query(
        `SELECT id, client_request_id AS "clientRequestId", question, status,
                started_at AS "startedAt", finished_at AS "finishedAt", error_code AS "errorCode",
                user_message_id::int AS "userMessageId", assistant_message_id::int AS "assistantMessageId",
                created_at AS "createdAt"
         FROM conversation_runs WHERE conversation_id = $1 ORDER BY created_at ASC`, [id]),
      this.database.query(
        `SELECT id, kind, user_message_id::int AS "userMessageId", question, final_answer AS "finalAnswer",
                refused, status, error_code AS "errorCode", input_tokens AS "inputTokens",
                output_tokens AS "outputTokens", total_tokens AS "totalTokens", duration_ms AS "durationMs",
                created_at AS "createdAt"
         FROM chat_traces WHERE conversation_id = $1 ORDER BY created_at ASC`, [id]),
    ]);
    return { ...conversation.rows[0], messages: messages.rows, runs: runs.rows, traces: traces.rows };
  }

  private normalizeStatus(value: string): ConversationStatusFilter {
    const normalized = value || 'all';
    if (!['all', 'answered', 'refused', 'failed', 'active'].includes(normalized)) {
      throw new BadRequestException('Invalid conversation status filter');
    }
    return normalized as ConversationStatusFilter;
  }
}
