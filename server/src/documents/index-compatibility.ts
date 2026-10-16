import { effectiveAgentVersion } from "../agent-management/effective-agent-version";
import { ConflictException } from "@nestjs/common";
import type { DatabaseService } from "../database.service";
import { indexEmbeddingFingerprint } from "./retrieval-compatibility";

/** Hybrid Agents may fall back to fulltext; pure-vector bindings may not. */
export async function assertIndexCompatible(
  db: Pick<DatabaseService, "query">,
  knowledgeBaseId: number,
  config: { indexMode: string; embeddingProfileId?: number | null },
  snapshot?: unknown,
) {
  const agents = (
    await db.query(
      `SELECT DISTINCT r.name,
    (v.config->>'embeddingPlanVersionId')::bigint AS "embeddingPlanVersionId",e.config AS "embeddingConfig"
    FROM agent_resources r
    JOIN agent_resource_versions v ON v.resource_id=r.id
    LEFT JOIN embedding_profiles e ON e.model_plan_version_id=(v.config->>'embeddingPlanVersionId')::bigint
    WHERE ${effectiveAgentVersion("r", "v")} AND (r.enabled OR EXISTS(
      SELECT 1 FROM agent_resources coordinator JOIN agent_resource_versions composition ON composition.id=coordinator.current_version_id
      WHERE coordinator.workspace_id=r.workspace_id AND coordinator.kind='agent' AND coordinator.enabled AND coordinator.archived_at IS NULL AND coordinator.deleted_at IS NULL
      AND composition.config->'collaboration'->'memberVersionIds' @> jsonb_build_array(v.id))) AND r.archived_at IS NULL AND r.deleted_at IS NULL AND v.config->'knowledgeBaseIds' @> $1::jsonb
      AND v.config->'retrieval'->>'retrievalMode'='vector'`,
      [JSON.stringify([knowledgeBaseId])],
    )
  ).rows;
  if (!agents.length) return;
  if (config.indexMode === "economy")
    throw new ConflictException(
      `以下 Agent 使用纯向量检索，不能切换为全文索引：${agents.map((a) => a.name).join("、")}`,
    );
  if (!agents.some((a) => a.embeddingPlanVersionId)) return; // Legacy Agents use each index's own model.
  const target =
    snapshot ??
    (config.embeddingProfileId
      ? (
          await db.query("SELECT config FROM embedding_profiles WHERE id=$1", [
            config.embeddingProfileId,
          ])
        ).rows[0]?.config
      : null);
  const fingerprint = indexEmbeddingFingerprint(target);
  const incompatible = agents.filter(
    (a) =>
      a.embeddingPlanVersionId &&
      (!fingerprint ||
        indexEmbeddingFingerprint(a.embeddingConfig) !== fingerprint),
  );
  if (incompatible.length)
    throw new ConflictException(
      `此索引模型与纯向量 Agent 不兼容，请先调整 Agent 模型或策略：${incompatible.map((a) => a.name).join("、")}`,
    );
}
