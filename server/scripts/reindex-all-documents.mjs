import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';

const host = process.env.POSTGRES_HOST || '127.0.0.1';
const port = Number(process.env.POSTGRES_PORT || 5433);
const database = process.env.POSTGRES_DB || 'agent_studio';
const user = process.env.POSTGRES_USER || 'grounded';
const password = process.env.POSTGRES_PASSWORD;
if (!password) throw new Error('POSTGRES_PASSWORD is required');
const connectionString = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
const model = process.env.EMBEDDING_MODEL || 'doubao-embedding-vision-251215';
const pool = new Pool({ connectionString });
const boss = new PgBoss(connectionString);

try {
  await boss.start();
  await boss.createQueue('document-ingest');
  const result = await pool.query(
    "SELECT id::int FROM documents WHERE archived_at IS NULL AND status = 'ready' ORDER BY id",
  );
  const ids = result.rows.map((row) => row.id);
  if (ids.length === 0) {
    console.log('No active ready documents to reindex');
    process.exitCode = 0;
  } else {
    for (const id of ids) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const changed = await client.query(
          "UPDATE documents SET status = 'queued', error_message = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NULL AND status = 'ready' RETURNING id",
          [id],
        );
        if (changed.rowCount !== 1) throw new Error(`Document ${id} changed state during reindex`);
        const jobId = await boss.send('document-ingest', { documentId: id }, {
          retryLimit: 2,
          retryDelay: 5,
          retryBackoff: true,
          db: { executeSql: (sql, values) => client.query(sql, values) },
        });
        if (!jobId) throw new Error(`Failed to queue document ${id}`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    console.log(`Queued ${ids.length} active documents for ${model}`);
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const status = await pool.query(
        `SELECT d.status, count(*)::int AS count
         FROM documents d WHERE d.id = ANY($1::bigint[]) GROUP BY d.status`, [ids],
      );
      const counts = Object.fromEntries(status.rows.map((row) => [row.status, row.count]));
      if (counts.failed) throw new Error(`${counts.failed} documents failed reindexing; inspect worker logs`);
      if (counts.ready === ids.length) {
        const coverage = await pool.query(
          `SELECT count(*)::int AS chunks,
                  count(c.embedding) FILTER (WHERE c.embedding_model = $2)::int AS vectors
           FROM document_chunks c JOIN documents d ON d.id = c.document_id
           WHERE d.id = ANY($1::bigint[])`, [ids, model],
        );
        const { chunks, vectors } = coverage.rows[0];
        if (chunks === 0 || chunks !== vectors) throw new Error('Ready documents have incomplete vectors');
        console.log(`Ready ${ids.length}/${ids.length}; ${vectors} vectors for ${model}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const unfinished = await pool.query(
      "SELECT count(*)::int AS count FROM documents WHERE id = ANY($1::bigint[]) AND status <> 'ready'", [ids],
    );
    if (unfinished.rows[0].count) throw new Error(`${unfinished.rows[0].count} documents did not finish reindexing`);
  }
} finally {
  await boss.stop();
  await pool.end();
}
