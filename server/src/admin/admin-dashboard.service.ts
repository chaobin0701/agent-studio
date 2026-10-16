import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export type DashboardRange = '24h' | '7d' | '30d';

export function dashboardWindow(value: unknown, now = new Date()) {
  if (value !== '24h' && value !== '7d' && value !== '30d') throw new BadRequestException('统计范围仅支持 24h、7d 或 30d');
  const days = value === '7d' ? 7 : 30;
  const local = new Date(now.getTime() + 8 * 3600000);
  const start = value === '24h' ? now.getTime() - 24 * 3600000
    : Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * 3600000 - (days - 1) * 86400000;
  return { key: value, since: new Date(start).toISOString(), until: now.toISOString(), timezone: 'Asia/Shanghai' as const, bucket: value === '24h' ? 'hour' : 'day' };
}

type Row = Record<string, unknown>;
const numberFields = (row: Row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : Number(value)]));

@Injectable()
export class AdminDashboardService {
  constructor(private readonly database: DatabaseService) {}

  async overview(range: unknown, permissionCodes: string[]) {
    const window = dashboardWindow(range);
    const conversations = permissionCodes.includes('conversations.read');
    const knowledge = permissionCodes.includes('documents.read') || permissionCodes.includes('knowledge_bases.manage');
    if (!conversations && !knowledge) throw new ForbiddenException('没有概览数据查看权限');
    const [activity, resources] = await Promise.all([
      conversations ? this.activity(window) : null,
      knowledge ? this.knowledge() : null,
    ]);
    return { generatedAt: window.until, range: window, activity, knowledge: resources };
  }

  private async activity(window: ReturnType<typeof dashboardWindow>) {
    const params = [window.since, window.until];
    const [summary, audience, runs, trend, attention] = await Promise.all([
      this.database.query<Row>(`/* dashboard:answers */
        SELECT count(*)::int AS "requestCount",
          count(*) FILTER (WHERE status='completed' AND COALESCE(refused,false)=false)::int AS "answeredCount",
          count(*) FILTER (WHERE status='completed' AND refused=true)::int AS "refusedCount",
          count(*) FILTER (WHERE status='failed')::int AS "failedCount",
          round(avg(duration_ms) FILTER (WHERE status='completed' AND duration_ms>=0))::float AS "averageDurationMs",
          (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status='completed' AND duration_ms>=0))::float AS "p95DurationMs",
          sum(total_tokens)::float AS "totalTokens", count(total_tokens)::int AS "tokenRecordedCount"
        FROM chat_traces WHERE kind='answer' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`, params),
      this.database.query<Row>(`/* dashboard:audience */
        SELECT count(DISTINCT c.id)::int AS "conversationCount", count(DISTINCT c.visitor_session_id)::int AS "visitorCount"
        FROM conversations c JOIN conversation_messages m ON m.conversation_id=c.id
        WHERE m.role='user' AND m.created_at >= $1::timestamptz AND m.created_at < $2::timestamptz`, params),
      this.database.query<Row>(`/* dashboard:runs */
        SELECT count(*) FILTER (WHERE status IN ('queued','running') AND expires_at > $2::timestamptz)::int AS "runningCount",
          count(*) FILTER (WHERE status IN ('queued','running') AND expires_at <= $2::timestamptz)::int AS "expiredCount",
          count(*) FILTER (WHERE status='failed' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz)::int AS "failedRunCount"
        FROM conversation_runs`, params),
      this.database.query<Row>(`/* dashboard:trend */
        WITH buckets AS (
          SELECT generate_series(date_trunc($3, $1::timestamptz AT TIME ZONE 'Asia/Shanghai'),
            date_trunc($3, ($2::timestamptz - interval '1 microsecond') AT TIME ZONE 'Asia/Shanghai'),
            CASE WHEN $3='hour' THEN interval '1 hour' ELSE interval '1 day' END) AS period
        ), totals AS (
          SELECT date_trunc($3, created_at AT TIME ZONE 'Asia/Shanghai') AS period,
            count(*) FILTER (WHERE status='completed' AND COALESCE(refused,false)=false)::int AS answered,
            count(*) FILTER (WHERE status='completed' AND refused=true)::int AS refused,
            count(*) FILTER (WHERE status='failed')::int AS failed
          FROM chat_traces WHERE kind='answer' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY 1
        ) SELECT to_char(b.period,'YYYY-MM-DD"T"HH24:MI:SS') || '+08:00' AS time,
          to_char(b.period, CASE WHEN $3='hour' THEN 'HH24:MI' ELSE 'MM-DD' END) AS label,
          COALESCE(t.answered,0) AS answered, COALESCE(t.refused,0) AS refused, COALESCE(t.failed,0) AS failed
        FROM buckets b LEFT JOIN totals t ON t.period=b.period ORDER BY b.period`, [...params, window.bucket]),
      this.database.query<Row>(`/* dashboard:attention */
        SELECT * FROM (
          SELECT t.id::text AS "traceId",t.conversation_id AS "conversationId",left(t.question,160) AS question,
            t.error_code AS "errorCode",'failed'::text AS status,t.created_at AS "createdAt"
          FROM chat_traces t WHERE t.kind='answer' AND t.status='failed' AND t.conversation_id IS NOT NULL AND t.created_at >= $1::timestamptz AND t.created_at < $2::timestamptz
          UNION ALL
          SELECT NULL::text,r.conversation_id,left(r.question,160),r.error_code,
            CASE WHEN r.status='failed' THEN 'failed' ELSE 'expired' END,r.created_at
          FROM conversation_runs r WHERE
            ((r.status='failed' AND r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz)
              OR (r.status IN ('queued','running') AND r.expires_at <= $2::timestamptz))
            AND NOT EXISTS (SELECT 1 FROM chat_traces t WHERE t.kind='answer' AND t.conversation_id=r.conversation_id AND t.user_message_id=r.user_message_id)
        ) failures ORDER BY "createdAt" DESC LIMIT 5`, params),
    ]);
    const metrics = numberFields({ ...summary.rows[0], ...audience.rows[0], ...runs.rows[0] });
    if (metrics.requestCount === 0) metrics.totalTokens = 0;
    return { ...metrics, trend: trend.rows, recentFailures: attention.rows };
  }

  private async knowledge() {
    const [summary, failures] = await Promise.all([
      this.database.query<Row>(`/* dashboard:knowledge */
        WITH bases AS (SELECT * FROM knowledge_bases WHERE archived_at IS NULL),
        files AS (SELECT d.* FROM documents d JOIN bases kb ON kb.id=d.knowledge_base_id WHERE d.archived_at IS NULL AND d.source_type='file'),
        searchable AS (
          SELECT c.id,c.document_id FROM document_chunks c JOIN files d ON d.id=c.document_id JOIN bases kb ON kb.id=d.knowledge_base_id
          WHERE kb.enabled_for_chat AND kb.active_index_version_id IS NULL AND d.enabled_for_retrieval AND d.status='ready'
          UNION ALL
          SELECT c.id,c.document_id FROM index_chunks c JOIN files d ON d.id=c.document_id JOIN bases kb ON kb.id=d.knowledge_base_id
          JOIN knowledge_index_versions v ON v.id=c.version_id AND v.id=kb.active_index_version_id AND v.status='ready'
          WHERE kb.enabled_for_chat AND d.enabled_for_retrieval AND c.kind <> 'parent'
        ) SELECT (SELECT count(*)::int FROM bases) AS "baseCount",
          (SELECT count(*)::int FROM bases WHERE enabled_for_chat) AS "enabledBaseCount",
          (SELECT count(*)::int FROM files) AS "documentCount",
          (SELECT count(*)::int FROM files WHERE status='ready') AS "readyCount",
          (SELECT count(DISTINCT document_id)::int FROM searchable) AS "retrievableCount",
          (SELECT count(*)::int FROM searchable) AS "chunkCount",
          (SELECT count(*)::int FROM files WHERE status IN ('pending','queued','processing','extracted')) AS "processingCount",
          (SELECT count(*)::int FROM files WHERE status='failed') AS "failedCount"`),
      this.database.query<Row>(`/* dashboard:failed-documents */
        SELECT d.id::int,d.knowledge_base_id::int AS "baseId",d.title,kb.name AS "baseName",d.updated_at AS "updatedAt"
        FROM documents d JOIN knowledge_bases kb ON kb.id=d.knowledge_base_id
        WHERE d.status='failed' AND d.archived_at IS NULL AND d.source_type='file' AND kb.archived_at IS NULL
        ORDER BY d.updated_at DESC,d.id DESC LIMIT 5`),
    ]);
    return { ...numberFields(summary.rows[0] ?? {}), recentFailures: failures.rows };
  }
}
