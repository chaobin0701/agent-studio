import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { PoolClient } from 'pg';
import { AppConfigService } from '../config/config.service';
import { currentWorkspaceId } from '../workspaces/workspace-context';

export const DOCUMENT_INGEST_QUEUE = 'document-ingest';
export const KNOWLEDGE_INDEX_QUEUE = 'knowledge-index';
export const KNOWLEDGE_AUTO_QUEUE = 'knowledge-auto-index';

export async function startDocumentQueues(boss: PgBoss): Promise<void> {
  await boss.start();
  await boss.createQueue(DOCUMENT_INGEST_QUEUE);
  await boss.createQueue(KNOWLEDGE_INDEX_QUEUE);
  await boss.createQueue(KNOWLEDGE_AUTO_QUEUE);
  // Migration 0039 runs before pg-boss exists on a fresh database. Apply its
  // grants after creating the queue tables, for both API and worker startup.
  await boss.getDb().executeSql(`DO $$ BEGIN
    PERFORM pg_advisory_xact_lock(351039);
    GRANT USAGE ON SCHEMA pgboss TO agent_studio_workspace_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA pgboss TO agent_studio_workspace_runtime;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO agent_studio_workspace_runtime;
  END $$`);
}

@Injectable()
export class DocumentQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly boss: PgBoss;

  constructor(config: AppConfigService) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
    this.boss = new PgBoss(config.databaseUrl);
  }

  async onModuleInit(): Promise<void> {
    await startDocumentQueues(this.boss);
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop();
  }

  async enqueue(client: PoolClient, documentId: number): Promise<void> {
    const jobId = await this.boss.send(DOCUMENT_INGEST_QUEUE, { documentId,workspaceId:currentWorkspaceId() }, {
      retryLimit: 2,
      retryDelay: 5,
      retryBackoff: true,
      db: { executeSql: (sql, values) => client.query(sql, values) },
    });
    if (!jobId) throw new Error('Failed to enqueue document');
  }

  async enqueueIndex(client: PoolClient, versionId: number): Promise<void> {
    const jobId = await this.boss.send(KNOWLEDGE_INDEX_QUEUE, { versionId,workspaceId:currentWorkspaceId() }, {
      retryLimit: 2, retryDelay: 10, retryBackoff: true, expireInSeconds: 1800,
      db: { executeSql: (sql, values) => client.query(sql, values) },
    });
    if (!jobId) throw new Error('Failed to enqueue knowledge index');
  }
  async enqueueAuto(client: PoolClient, knowledgeBaseId: number): Promise<void> {
    await this.boss.send(KNOWLEDGE_AUTO_QUEUE,{knowledgeBaseId,workspaceId:currentWorkspaceId()}, {
      retryLimit:30,retryDelay:2,expireInSeconds:1800,
      db:{executeSql:(sql,values)=>client.query(sql,values)},
    });
  }
}
