import { runtimeScope } from "../../agent-management/runtime-scope";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { SearchService } from "../../documents/search.service";
import { AgentTool } from "./agent-tool";
import { ToolContext } from "./tool-context";
import { ToolResult } from "./tool-result";
import { knowledgeResources } from "../context/context-contribution";
import {
  executionSpan,
  annotateExecution,
} from "../../observability/execution-tracer";

const inputSchema = z.object({
  query: z.string().trim().min(2).max(200),
  topK: z.number().int().min(1).max(8).optional(),
});

@Injectable()
export class KnowledgeSearchTool
  implements AgentTool<z.infer<typeof inputSchema>>
{
  readonly name = "search_knowledge";
  readonly capabilities = ["knowledge-search"] as const;
  readonly description =
    "检索当前 Agent 授权的知识库文档，只返回资料中可以验证的内容。";
  readonly inputSchema = inputSchema;
  readonly planning = { canBatch: true } as const;
  readonly contributeContext = knowledgeResources;

  constructor(private readonly search: SearchService) {}

  async execute(
    input: z.infer<typeof inputSchema>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const agent = runtimeScope.getStore();
    if (agent && !agent.knowledge.length)
      return {
        success: true,
        content: "此 Agent 未关联可用知识库。",
        data: {
          hits: [],
          retrievalMode: "lexical-only",
          vectorIndexedChunks: 0,
        },
      };
    const result = await executionSpan(
      "knowledge_retrieval",
      "retriever",
      {
        retrievalMode: agent?.spec.retrieval?.retrievalMode,
        embeddingPlanVersionId: agent?.embeddingPlan?.id ?? null,
      },
      async () => {
        _context.signal?.throwIfAborted();
        const value = await this.search.searchForAgent(
          input.query,
          agent ? (agent.spec.retrieval?.topK ?? 5) : (input.topK ?? 5),
          agent?.knowledge,
          agent?.spec.retrieval,
          agent?.embeddingProfile,
          _context.signal,
        );
        _context.signal?.throwIfAborted();
        annotateExecution({
          hitCount: value.hits.length,
          embeddingCalls: value.embeddingCalls,
          retrievalMode: value.retrievalMode,
        });
        return value;
      },
    );
    const evidence = result.hits.map((hit) => ({
      chunkId: hit.chunkId,
      title: hit.documentTitle,
      heading: hit.headingPath,
      content: hit.content.slice(0, 1800),
      score: hit.score,
    }));
    return {
      success: true,
      references: result.hits.map((hit) => ({
        kind: "knowledge",
        id: String(hit.chunkId),
        title: hit.documentTitle,
        metadata: {
          documentId: hit.documentId,
          originalFilename: hit.originalFilename,
          sourceStartLine: hit.sourceStartLine,
          sourceEndLine: hit.sourceEndLine,
          ...(hit.indexVersionId ? { indexVersionId: hit.indexVersionId } : {}),
        },
      })),
      content: evidence.length
        ? evidence
            .map(
              (item) =>
                `[${item.chunkId}] ${item.title}${item.heading ? ` · ${item.heading}` : ""}\n${item.content}`,
            )
            .join("\n\n")
        : "未找到足以支持回答的资料片段。",
      data: {
        hits: result.hits,
        retrievalMode: result.retrievalMode,
        vectorIndexedChunks: result.vectorIndexedChunks,
        retrievalConfigs: result.retrievalConfigs,
      },
      metadata: {
        retrievalMode: result.retrievalMode,
        vectorIndexedChunks: result.vectorIndexedChunks,
        embeddingPlanVersionId: agent?.embeddingPlan?.id ?? null,
        embeddingCalls: result.embeddingCalls,
        retrievalConfigs: result.retrievalConfigs,
      },
    };
  }
}
