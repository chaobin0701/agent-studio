import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database.service";
import { IntegrationService } from "../integrations/integration.service";
import type { IntegrationIdentity } from "../integrations/integration.types";
import {
  FILE_OUTPUT_LIMITS,
  fileDescriptor,
  validOutputPath,
  type PendingFileOutput,
} from "./file-output";
import type { AgentArtifact } from "../ai/agent/execution-contract";
import { executionSpan } from "../observability/execution-tracer";

type Query = Pick<PoolClient, "query">;
type Owner = {
  source: "generic_run" | "chat";
  traceId: string;
  runId: string | null;
  entryVersionId: number;
  applicationId: string | null;
  visitorSessionId: string | null;
  adminActorId?: number;
  conversationId?: string;
};
export type StoredArtifactMetadata = {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  expiresAt: string;
  producerVersionId: number;
  purgedAt: string | null;
  available: boolean;
};
const metadataColumns = `a.id,a.filename,a.mime_type AS "mimeType",a.byte_size AS "byteSize",a.sha256,a.expires_at AS "expiresAt",a.producer_version_id::int AS "producerVersionId",a.purged_at AS "purgedAt"`;
const ready = `a.content IS NOT NULL AND a.expires_at>now() AND t.status='completed' AND NOT EXISTS(SELECT 1 FROM chatbot_turns ct JOIN chatbot_sessions cs ON cs.id=ct.session_id WHERE ct.id=a.run_id AND cs.deleted_at IS NOT NULL) AND
 ((a.source='generic_run' AND EXISTS(SELECT 1 FROM integration_calls i WHERE i.run_id=a.run_id AND i.app_id IS NOT DISTINCT FROM a.application_id AND i.visitor_session_id IS NOT DISTINCT FROM a.visitor_session_id AND i.admin_actor_id IS NOT DISTINCT FROM a.admin_actor_id AND i.status='completed' AND i.trace_id=a.trace_id)) OR
  (a.source='chat' AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=a.conversation_id AND c.application_id=a.application_id AND c.visitor_session_id=a.visitor_session_id) AND
    (a.run_id IS NULL OR EXISTS(SELECT 1 FROM conversation_runs r WHERE r.id=a.run_id AND r.status='completed' AND r.conversation_id=a.conversation_id))))`;

@Injectable()
export class ExecutionArtifactService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: IntegrationService,
  ) {}
  assertSelection(
    artifacts: readonly AgentArtifact[],
    files: readonly PendingFileOutput[],
  ) {
    const selected = artifacts.filter((file) => file.kind === "execution_file");
    if (
      selected.length !== files.length ||
      files.length > FILE_OUTPUT_LIMITS.files ||
      new Set(files.map((file) => file.id)).size !== files.length ||
      files.reduce((sum, file) => sum + file.byteSize, 0) >
        FILE_OUTPUT_LIMITS.totalBytes
    )
      throw new ConflictException("文件产物与执行结果不一致");
    for (const file of files) {
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
          file.id,
        ) ||
        !validOutputPath(`/workspace/outputs/${file.filename}`) ||
        Buffer.byteLength(file.content) !== file.byteSize ||
        file.byteSize > FILE_OUTPUT_LIMITS.fileBytes ||
        createHash("sha256").update(file.content).digest("hex") !==
          file.sha256 ||
        !selected.some(
          (artifact) =>
            JSON.stringify(artifact) === JSON.stringify(fileDescriptor(file)),
        )
      )
        throw new ConflictException("文件产物校验失败");
    }
  }
  async save(
    client: Query,
    owner: Owner,
    files: readonly PendingFileOutput[],
    artifacts: readonly AgentArtifact[],
  ) {
    this.assertSelection(artifacts, files);
    if (!files.length) return;
    await client.query(
      "SELECT pg_advisory_xact_lock(245131,(current_workspace_id()%2147483647)::int)",
    );
    const used = Number(
      (
        await client.query<{ bytes: string }>(
          "SELECT COALESCE(sum(byte_size),0)::text AS bytes FROM execution_artifacts WHERE content IS NOT NULL",
        )
      ).rows[0]?.bytes ?? 0,
    );
    if (
      used + files.reduce((sum, file) => sum + file.byteSize, 0) >
      FILE_OUTPUT_LIMITS.workspaceBytes
    )
      throw new ConflictException({
        code: "artifact_storage_limit",
        message: "工作区文件产物存储已达到上限，请清理已有文件后重试。",
      });
    await executionSpan(
      "artifact_persistence",
      "chain",
      {
        artifactCount: files.length,
        artifactBytes: files.reduce((sum, file) => sum + file.byteSize, 0),
      },
      async () => {
        for (const file of files) {
          await client.query(
            `INSERT INTO execution_artifacts(id,trace_id,run_id,source,entry_version_id,producer_version_id,application_id,visitor_session_id,conversation_id,filename,byte_size,sha256,content,expires_at,admin_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              file.id,
              owner.traceId,
              owner.runId,
              owner.source,
              owner.entryVersionId,
              file.producerVersionId,
              owner.applicationId,
              owner.visitorSessionId,
              owner.conversationId ?? null,
              file.filename,
              file.byteSize,
              file.sha256,
              Buffer.from(file.content),
              file.expiresAt,
              owner.adminActorId ?? null,
            ],
          );
          await client.query(
            `INSERT INTO execution_artifact_events(artifact_id,action,actor_kind,actor_id) VALUES($1,'created',$2,$3)`,
            [
              file.id,
              owner.adminActorId ? "admin" : "visitor",
              String(owner.adminActorId ?? owner.visitorSessionId),
            ],
          );
        }
      },
    );
  }
  async list(traceId: string) {
    if (
      !(await this.db.query("SELECT 1 FROM chat_traces WHERE id=$1", [traceId]))
        .rowCount
    )
      throw new NotFoundException("执行记录不存在");
    return (
      await this.db.query<StoredArtifactMetadata>(
        `SELECT ${metadataColumns},(${ready}) AS available FROM execution_artifacts a JOIN chat_traces t ON t.id=a.trace_id WHERE a.trace_id=$1 ORDER BY a.created_at,a.id`,
        [traceId],
      )
    ).rows;
  }
  async downloadForApp(
    identity: IntegrationIdentity,
    agentId: number,
    id: string,
    userId?: string,
  ) {
    if (identity.app.agentId !== agentId)
      throw new ForbiddenException("此接入应用没有访问该 Agent 的权限");
    this.access.assertScope(identity, "conversations:read");
    this.access.checkInspectionRate(identity);
    const owner = await this.access.platformOwner(identity, userId);
    return this.read(
      id,
      undefined,
      { applicationId: identity.app.id, owner, agentId },
      "visitor",
      owner,
    );
  }
  downloadForAdmin(traceId: string, id: string, actorId: number) {
    return this.read(id, traceId, undefined, "admin", String(actorId));
  }
  private async read(
    id: string,
    traceId: string | undefined,
    owner:
      | { applicationId: string; owner: string; agentId: number }
      | undefined,
    kind: "admin" | "visitor",
    actor: string,
  ) {
    return this.db.transaction(async (client) => {
      const row = (
        await client.query<StoredArtifactMetadata & { content: Buffer }>(
          `SELECT ${metadataColumns},a.content FROM execution_artifacts a JOIN chat_traces t ON t.id=a.trace_id WHERE a.id=$1 AND ($2::uuid IS NULL OR a.trace_id=$2) AND ($3::uuid IS NULL OR (a.application_id=$3 AND a.visitor_session_id=$4 AND EXISTS(SELECT 1 FROM agent_resource_versions v WHERE v.id=a.entry_version_id AND v.resource_id=$5))) AND ${ready} FOR SHARE OF a`,
          [
            id,
            traceId ?? null,
            owner?.applicationId ?? null,
            owner?.owner ?? null,
            owner?.agentId ?? null,
          ],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("文件产物不存在、已过期或已清理");
      if (
        !Buffer.isBuffer(row.content) ||
        row.content.length !== row.byteSize ||
        createHash("sha256").update(row.content).digest("hex") !== row.sha256
      )
        throw new ConflictException("文件产物完整性校验失败");
      await client.query(
        `INSERT INTO execution_artifact_events(artifact_id,action,actor_kind,actor_id) VALUES($1,'downloaded',$2,$3)`,
        [id, kind, actor],
      );
      return {
        metadata: { ...row, content: undefined, available: true },
        content: row.content,
      };
    });
  }
  async purge(traceId: string, id: string, actorId: number) {
    return this.db.transaction(async (client) => {
      const row = (
        await client.query(
          "SELECT id FROM execution_artifacts WHERE id=$1 AND trace_id=$2 FOR UPDATE",
          [id, traceId],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("文件产物不存在");
      const updated = await client.query(
        "UPDATE execution_artifacts SET content=NULL,purged_at=now() WHERE id=$1 AND purged_at IS NULL RETURNING id",
        [id],
      );
      if (updated.rowCount) {
        await client.query(
          "INSERT INTO execution_artifact_events(artifact_id,action,actor_kind,actor_id) VALUES($1,'purged','admin',$2)",
          [id, String(actorId)],
        );
        await client.query(
          "INSERT INTO audit_logs(actor_admin_id,action,target_type,target_id,details) VALUES($1,'execution_artifact.purged','execution_artifact',$2,$3::jsonb)",
          [actorId, id, JSON.stringify({ traceId })],
        );
      }
      return { ok: true };
    });
  }
  async discardFailed(traceId: string) {
    await this.db.transaction(async (client) => {
      const rows = (
        await client.query<{ id: string }>(
          "UPDATE execution_artifacts a SET content=NULL,purged_at=now() FROM chat_traces t WHERE a.trace_id=$1 AND t.id=a.trace_id AND t.status='failed' AND a.content IS NOT NULL RETURNING a.id",
          [traceId],
        )
      ).rows;
      for (const row of rows)
        await client.query(
          "INSERT INTO execution_artifact_events(artifact_id,action,actor_kind,actor_id) VALUES($1,'failed_purged','system','execution_failure')",
          [row.id],
        );
    });
  }
}
