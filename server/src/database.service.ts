import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import * as schema from './db/schema';
import { AppConfigService } from './config/config.service';
import { scopedPool } from './workspaces/scoped-pool';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private readonly platformPool: Pool;
  readonly db: ReturnType<typeof drizzle<typeof schema>>;

  constructor(config: AppConfigService) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
    this.platformPool = new Pool({ connectionString: config.databaseUrl });
    this.pool = scopedPool(this.platformPool);
    this.db = drizzle(this.pool, { schema });
  }

  async onModuleInit(): Promise<void> {
    await this.check();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async check(): Promise<void> {
    await this.db.execute(sql`SELECT 1`);
  }

  query<T extends QueryResultRow>(statement: string, values: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(statement, values);
  }

  /** Restricted callers: account/membership administration and authenticated app discovery.
   * Business resource access must always use query/db/transaction instead. */
  platformQuery<T extends QueryResultRow>(statement: string, values: unknown[] = []): Promise<QueryResult<T>> {
    return this.platformPool.query<T>(statement, values);
  }

  async platformTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client=await this.platformPool.connect();
    try { await client.query('BEGIN'); const result=await work(client); await client.query('COMMIT'); return result; }
    catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
