import { runtimeScope } from "../agent-management/runtime-scope";
import { Injectable, Optional } from "@nestjs/common";
import { SearchService } from "../documents/search.service";
import type { AgentConfiguration } from "../config/agent-config";
import {
  readContextBlocks,
  canUseContextSource,
  evidenceDigest,
  type ContextResource,
  type RestoredContext,
} from "../ai/context/context-contribution";
import { ContextGovernor } from "./context-governor";

@Injectable()
export class ContextMemoryService {
  constructor(
    private readonly search: SearchService,
    @Optional() private readonly governor?: ContextGovernor,
  ) {}

  /** Revalidate a mounted resource at use time, without a new search/embedding. */
  async validateResource(
    resource: ContextResource,
    configuration: AgentConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (resource.kind !== "knowledge")
      throw new Error("Context resource is unavailable");
    {
      if (!configuration.runtime.allowedTools.includes("search_knowledge"))
        throw new Error("Context resource is unavailable");
      const current = await this.search.restoreEvidence(
        [resource.data],
        runtimeScope.getStore()?.knowledge,
      );
      signal.throwIfAborted();
      if (
        !current.some(
          (hit) =>
            hit.chunkId === resource.data.chunkId &&
            hit.documentId === resource.data.documentId &&
            evidenceDigest(hit) === resource.digest,
        )
      )
        throw new Error("Context resource is unavailable");
    }
  }

  async restore(
    conversationId: string,
    blocks: unknown,
    configuration: AgentConfiguration,
  ): Promise<RestoredContext> {
    const allowed = new Set(configuration.runtime.allowedTools);
    const unique = new Map<string, ContextResource>();
    const permittedKeys = new Set<string>();
    // Caller supplies newest traces first. Never let an older resource replace a newer one.
    for (const block of readContextBlocks(blocks, conversationId)) {
      for (const resource of block.resources) {
        // An older trace may lack index metadata; it still represents the same chunk.
        const identity = `knowledge:${resource.data.documentId}:${resource.data.chunkId}`;
        if (unique.has(identity)) continue;
        unique.set(identity, resource);
        if (
          canUseContextSource(block.source, configuration.runtime.allowedTools)
        )
          permittedKeys.add(resource.key);
      }
    }
    const candidates = [...unique.values()].slice(0, 44);
    const result: RestoredContext = {
      resources: [],
      evidence: [],
      diagnostics: {
        enabled: true,
        candidates: candidates.length,
        restored: 0,
        omitted: candidates.length,
      },
    };
    const knowledge = candidates
      .filter(
        (r): r is Extract<ContextResource, { kind: "knowledge" }> =>
          r.kind === "knowledge",
      )
      .slice(0, 24);
    let evidence: typeof result.evidence = [];
    const bounded = async <T>(
      operation: Promise<T>,
      fallback: T,
    ): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<T>((resolve) => {
            timer = setTimeout(
              () => resolve(fallback),
              Math.min(configuration.runtime.toolTimeoutMs, 3000),
            );
          }),
        ]);
      } catch {
        return fallback;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await Promise.all([
      knowledge.length && allowed.has("search_knowledge")
        ? bounded(
            this.search.restoreEvidence(
              knowledge.map((r) => r.data),
              runtimeScope.getStore()?.knowledge,
            ),
            evidence,
          ).then((value) => {
            evidence = value;
          })
        : undefined,
    ]);
    const inputTokens = this.governor?.inspect({
      systemPrompt: "",
      userPrompt: "",
      purpose: "planner",
    }).inputBudgetTokens;
    const budget = Math.min(
      24000,
      configuration.runtime.maxToolResultChars * 2,
      inputTokens === undefined ? 24000 : Math.floor(inputTokens * 2 * 0.35),
    );
    let used = 0;
    for (const resource of candidates) {
      if (!permittedKeys.has(resource.key)) continue;
      const valid = evidence.some(
        (hit) =>
          hit.chunkId === resource.data.chunkId &&
          hit.documentId === resource.data.documentId &&
          evidenceDigest(hit) === resource.digest,
      );
      if (!valid) continue;
      const size = JSON.stringify(resource).length;
      if (used + size > budget) continue;
      result.resources.push(resource);
      used += size;
      result.evidence.push(resource.data);
    }
    result.diagnostics.restored = result.resources.length;
    result.diagnostics.omitted = candidates.length - result.resources.length;
    return result;
  }
}
