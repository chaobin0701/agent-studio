import { BadRequestException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database.service";
import { AppConfigService } from "../config/config.service";
import {
  agentRetrievalSchema,
  buildSettings,
  type AgentRetrieval,
} from "./knowledge-config";
import {
  embeddingProfileSchema,
  embeddingFingerprint,
  type EmbeddingProfile,
} from "./profile-embedding";
import { embedForProfile } from "./embedding-runtime";
import { searchTokens } from "./build-chunks";
import { fuseSearchResults, type SearchHit } from "./fuse-search-results";
import type { KnowledgeScope } from "../agent-management/runtime-scope";
import {
  indexEmbeddingFingerprint,
  retrievalDecision,
} from "./retrieval-compatibility";
import {
  executionSpan,
  annotateExecution,
} from "../observability/execution-tracer";
export function queryVectorKey(profile: EmbeddingProfile) {
  return JSON.stringify([
    profile.profileId ?? null,
    profile.secretRef,
    embeddingFingerprint(profile),
  ]);
}
export function mergeKnowledgeCandidates(lists: SearchHit[][], limit: number) {
  const hits = new Map<number, SearchHit & { fusionScore: number }>();
  for (const list of lists)
    list.forEach((hit, rank) => {
      const current = hits.get(hit.chunkId) ?? { ...hit, fusionScore: 0 };
      current.fusionScore += 1 / (60 + rank + 1);
      hits.set(hit.chunkId, current);
    });
  return [...hits.values()]
    .sort(
      (a, b) =>
        b.fusionScore - a.fusionScore ||
        a.documentId - b.documentId ||
        a.ordinal - b.ordinal,
    )
    .slice(0, limit);
}
function boundedContext(hits: SearchHit[], limit: number) {
  let remaining = limit;
  return hits.flatMap((hit) => {
    remaining -= Array.from(
      `${hit.documentTitle}\n${hit.headingPath}\n`,
    ).length;
    if (remaining <= 0) return [];
    const chars = Array.from(hit.content),
      size = Math.min(chars.length, remaining);
    remaining -= size;
    return [
      {
        ...hit,
        content: chars.slice(0, size).join(""),
        ...(size < chars.length ? { contentTruncated: true } : {}),
      },
    ];
  });
}
@Injectable()
export class VersionSearchService {
  constructor(
    private readonly database: DatabaseService,
    private readonly runtime: AppConfigService,
  ) {}
  private async versions(knowledgeBaseId?: number, versionId?: number) {
    return (
      await this.database.query(
        `SELECT v.id::int,v.config,v.embedding_snapshot,kb.id::int AS "knowledgeBaseId"
      FROM knowledge_bases kb JOIN knowledge_index_versions v ON v.knowledge_base_id=kb.id AND v.id=COALESCE($2::bigint,kb.active_index_version_id)
      WHERE kb.archived_at IS NULL AND v.status='ready' AND CASE WHEN $1::bigint IS NULL THEN kb.enabled_for_chat ELSE kb.id=$1 END`,
        [knowledgeBaseId ?? null, versionId ?? null],
      )
    ).rows;
  }
  private validate(query: unknown, limit: number) {
    if (
      typeof query !== "string" ||
      Array.from(query.trim()).length < 2 ||
      Array.from(query.trim()).length > 200 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new BadRequestException("Invalid search query or limit");
    return query.trim();
  }
  async search(
    rawQuery: unknown,
    limit: number,
    knowledgeBaseId?: number,
    versionId?: number,
    requestPolicy?: unknown,
  ) {
    const query = this.validate(rawQuery, limit);
    if (
      versionId !== undefined &&
      (!knowledgeBaseId || !Number.isSafeInteger(versionId) || versionId < 1)
    )
      throw new BadRequestException("Invalid version ID");
    // Standalone library diagnostics adapt to index capabilities, not Agent defaults.
    const policy = agentRetrievalSchema.parse(
      requestPolicy ?? { retrievalMode: "auto" },
    );
    return this.retrieve(
      query,
      await this.versions(knowledgeBaseId, versionId),
      policy,
      Math.min(limit, policy.topK),
      new Map(),
      knowledgeBaseId !== undefined,
    );
  }
  async searchMany(
    query: string,
    scope: KnowledgeScope,
    policy: AgentRetrieval,
    selectedProfile?: EmbeddingProfile,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    this.validate(query, policy.topK);
    const started = performance.now(),
      cache = new Map<string, Promise<number[]>>();
    if (
      policy.retrievalMode === "vector" &&
      scope.some((k) => k.indexVersionId === null)
    )
      throw new BadRequestException("向量检索知识库尚未构建可用索引");
    const groups = await Promise.all(
      scope
        .filter((k) => k.indexVersionId !== null)
        .map(async (k) => {
          const versions = await this.versions(k.id, k.indexVersionId!);
          if (policy.retrievalMode === "vector" && !versions.length)
            throw new BadRequestException("向量索引版本不可用");
          return this.retrieve(
            query,
            versions,
            policy,
            24,
            cache,
            false,
            false,
            selectedProfile,
            signal,
          );
        }),
    );
    signal?.throwIfAborted();
    const hits = await executionSpan(
      "fuse_knowledge_candidates",
      "chain",
      {},
      async () => {
        const values = boundedContext(
          mergeKnowledgeCandidates(
            groups.map((g) => g.hits),
            policy.topK,
          ),
          policy.contextChars,
        );
        annotateExecution({ hitCount: values.length });
        return values;
      },
    );
    return {
      hits,
      retrievalMode:
        policy.retrievalMode === "vector"
          ? ("vector" as const)
          : groups.some((g) => g.vectorIndexedChunks)
            ? ("hybrid" as const)
            : ("lexical-only" as const),
      vectorIndexedChunks: groups.reduce(
        (n, g) => n + g.vectorIndexedChunks,
        0,
      ),
      embeddingCalls: cache.size,
      retrievalConfigs: [
        ...groups.flatMap((g) => g.retrievalConfigs),
        ...scope
          .filter((k) => k.indexVersionId === null)
          .map((k) => ({
            knowledgeBaseId: k.id,
            indexVersionId: null,
            config: policy,
            requestedRetrievalMode: policy.retrievalMode,
            fallbackReason: "index_not_ready",
          })),
      ],
      durationMs: Math.round(performance.now() - started),
    };
  }
  private async retrieve(
    query: string,
    versions: any[],
    policy: AgentRetrieval,
    limit: number,
    cache: Map<string, Promise<number[]>>,
    diagnostic: boolean,
    bound = true,
    selectedProfile?: EmbeddingProfile,
    signal?: AbortSignal,
  ) {
    const started = performance.now();
    const groups = await Promise.all(
      versions.map((version) =>
        executionSpan(
          "knowledge_base_retrieval",
          "retriever",
          {
            knowledgeBaseId: version.knowledgeBaseId,
            indexVersionId: version.id,
            retrievalMode: policy.retrievalMode,
          },
          async () => {
            signal?.throwIfAborted();
            const config = buildSettings(version.config);
            const override = ["vector", "hybrid"].includes(policy.retrievalMode)
              ? selectedProfile
              : undefined;
            const decision = retrievalDecision(
              config.indexMode,
              policy.retrievalMode,
              indexEmbeddingFingerprint(version.embedding_snapshot),
              override ? embeddingFingerprint(override) : undefined,
            );
            const mode = decision.mode;
            const select = `SELECT COALESCE(p.id,c.id)::int AS "chunkId",d.id::int AS "documentId",c.document_title AS "documentTitle",c.original_filename AS "originalFilename",
        COALESCE(p.ordinal,c.ordinal) AS ordinal,COALESCE(p.heading_path,c.heading_path) AS "headingPath",COALESCE(p.content,c.content) AS content,
        COALESCE(p.source_locator,c.source_locator) AS "sourceLocator",(COALESCE(p.source_locator,c.source_locator)->>'start')::int AS "sourceStartLine",
        (COALESCE(p.source_locator,c.source_locator)->>'end')::int AS "sourceEndLine",'published' AS "indexKind",c.version_id::int AS "indexVersionId",d.knowledge_base_id::int AS "knowledgeBaseId"`;
            const joins = `FROM index_chunks c JOIN documents d ON d.id=c.document_id JOIN knowledge_bases kb ON kb.id=d.knowledge_base_id LEFT JOIN index_chunks p ON p.id=c.parent_chunk_id AND p.version_id=c.version_id`;
            const where = `c.version_id=$1 AND c.kind<>'parent' AND d.archived_at IS NULL AND d.deleted_at IS NULL AND d.enabled_for_retrieval AND kb.archived_at IS NULL AND ($5::boolean OR kb.enabled_for_chat)`;
            let lexical: SearchHit[] = [],
              vector: SearchHit[] = [],
              vectorIndexedChunks = 0;
            if (mode !== "vector")
              lexical = await executionSpan(
                "fulltext_recall",
                "retriever",
                {},
                async () => {
                  const hits = (
                    await this.database.query<SearchHit>(
                      `WITH scored AS (${select},GREATEST(ts_rank_cd(c.search_vector,plainto_tsquery('simple',$2),32),word_similarity($3,c.search_content),CASE WHEN position(lower($3) in lower(c.search_content))>0 THEN 1 ELSE 0 END) AS score ${joins} WHERE ${where}) SELECT * FROM scored WHERE score >= $4 ORDER BY score DESC,"chunkId" LIMIT $6`,
                      [
                        version.id,
                        searchTokens(query),
                        query,
                        policy.lexicalThreshold,
                        diagnostic,
                        32,
                      ],
                    )
                  ).rows;
                  annotateExecution({ hitCount: hits.length });
                  return hits;
                },
              );
            if (mode !== "fulltext") {
              const profile =
                  override ??
                  embeddingProfileSchema.parse(version.embedding_snapshot),
                key = queryVectorKey(profile);
              if (!cache.has(key))
                cache.set(
                  key,
                  embedForProfile(
                    this.database,
                    this.runtime,
                    profile,
                    [query],
                    signal,
                  ).then((v) => v[0]),
                );
              const queryVector = await cache.get(key)!;
              vectorIndexedChunks =
                (
                  await this.database.query<{ count: number }>(
                    "SELECT count(*)::int AS count FROM chunk_embeddings e JOIN index_chunks c ON c.id=e.chunk_id WHERE c.version_id=$1",
                    [version.id],
                  )
                ).rows[0]?.count ?? 0;
              vector = await executionSpan(
                "vector_recall",
                "retriever",
                {},
                async () => {
                  const hits = (
                    await this.database.query<SearchHit>(
                      `WITH compatible AS MATERIALIZED (SELECT e.* FROM chunk_embeddings e JOIN index_chunks c ON c.id=e.chunk_id WHERE c.version_id=$1 AND e.dimensions=$3 AND vector_dims(e.embedding)=$3),scored AS (${select},1-(e.embedding <=> $2::vector) AS score ${joins} JOIN compatible e ON e.chunk_id=c.id WHERE ${where}) SELECT * FROM scored WHERE score >= $4 ORDER BY score DESC,"chunkId" LIMIT $6`,
                      [
                        version.id,
                        `[${queryVector.join(",")}]`,
                        profile.dimensions,
                        policy.vectorThreshold,
                        diagnostic,
                        32,
                      ],
                    )
                  ).rows;
                  annotateExecution({ hitCount: hits.length });
                  return hits;
                },
              );
            }
            signal?.throwIfAborted();
            annotateExecution({
              retrievalMode: mode,
              hitCount: lexical.length + vector.length,
              fallbackReason: decision.fallbackReason,
            });
            const unique = (hits: SearchHit[]) => {
              const rows = new Map<number, SearchHit>();
              for (const hit of hits)
                if (!rows.has(hit.chunkId)) rows.set(hit.chunkId, hit);
              return [...rows.values()];
            };
            lexical = unique(lexical);
            vector = unique(vector);
            return {
              lexical,
              vector,
              hits: fuseSearchResults(lexical, vector, limit),
              vectorIndexedChunks,
              retrievalConfig: {
                knowledgeBaseId: version.knowledgeBaseId,
                indexVersionId: version.id,
                config: { ...policy, retrievalMode: mode },
                requestedRetrievalMode: policy.retrievalMode,
                fallbackReason: decision.fallbackReason,
                embeddingProfileId:
                  mode === "fulltext"
                    ? null
                    : (override?.profileId ??
                      version.embedding_snapshot?.profileId ??
                      null),
              },
            };
          },
        ),
      ),
    );
    const merged =
      groups.length === 1
        ? groups[0].hits
        : mergeKnowledgeCandidates(
            groups.map((g) => g.hits),
            limit,
          );
    return {
      hits: bound ? boundedContext(merged, policy.contextChars) : merged,
      lexicalResults: groups.flatMap((g) => g.lexical),
      vectorResults: groups.flatMap((g) => g.vector),
      vectorIndexedChunks: groups.reduce(
        (n, g) => n + g.vectorIndexedChunks,
        0,
      ),
      embeddingCalls: cache.size,
      versionIds: versions.map((v) => v.id),
      retrievalConfigs: groups.map((g) => g.retrievalConfig),
      retrievalMode:
        policy.retrievalMode === "vector"
          ? ("vector" as const)
          : groups.some((g) => g.vectorIndexedChunks)
            ? ("hybrid" as const)
            : ("lexical-only" as const),
      durationMs: Math.round(performance.now() - started),
    };
  }
}
