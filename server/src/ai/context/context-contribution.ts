import { createHash } from "node:crypto";
import { z } from "zod";
import type { SearchHit } from "../../documents/fuse-search-results";
import type { ToolResult } from "../tools/tool-result";
import type { AgentReference } from "../agent/execution-contract";

// Only explicitly declared, bounded business fields can become model memory.
// This is not a dump of arbitrary tool payloads, credentials or instructions.
const hitSchema = z.object({
  chunkId: z.number().int().positive(),
  documentId: z.number().int().positive(),
  documentTitle: z.string().max(500),
  originalFilename: z.string().max(500),
  ordinal: z.number().int().nonnegative().optional(),
  headingPath: z.string().max(2000),
  content: z.string().max(16000),
  sourceStartLine: z.number().int().nullable(),
  sourceEndLine: z.number().int().nullable(),
  score: z.number().finite(),
  indexKind: z.enum(["live", "published"]).optional(),
  indexVersionId: z.number().int().positive().optional(),
  knowledgeBaseId: z.number().int().positive().optional(),
});
export type ContextResource = {
  kind: "knowledge";
  key: string;
  digest: string;
  data: SearchHit;
};
export type ContextProjector = (result: ToolResult) => ContextResource[];

/** Capability-owned resource mapping, never framework business routing. */
export function resourceIdentity(resource: ContextResource): string {
  return `${resource.kind}:${resource.key}`;
}
export function contextReference(resource: ContextResource): AgentReference {
  return {
    kind: "knowledge",
    id: String(resource.data.chunkId),
    title: resource.data.documentTitle,
    metadata: {
      documentId: resource.data.documentId,
      knowledgeBaseId: resource.data.knowledgeBaseId ?? null,
      indexVersionId: resource.data.indexVersionId ?? null,
    },
  };
}
export type RuntimeContextBlock = {
  version: 1;
  source: string;
  origin: "model" | "preload" | "host";
  conversationId: string;
  traceId?: string;
  toolCallId?: string;
  occurredAt: string;
  resources: ContextResource[];
};
export type RestoredContext = {
  resources: ContextResource[];
  evidence: SearchHit[];
  diagnostics: {
    enabled: boolean;
    candidates: number;
    restored: number;
    omitted: number;
  };
};

export function evidenceDigest(hit: SearchHit): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        hit.documentId,
        hit.documentTitle,
        hit.headingPath,
        hit.originalFilename,
        hit.content,
        hit.sourceStartLine,
        hit.sourceEndLine,
      ]),
    )
    .digest("hex");
}
export function canUseContextSource(
  source: string,
  allowedTools: readonly string[],
): boolean {
  return allowedTools.includes(source);
}
export function knowledgeResources(result: ToolResult): ContextResource[] {
  if (!result.success) return [];
  const data = result.data as { hits?: unknown[] } | undefined;
  return (Array.isArray(data?.hits) ? data.hits.slice(0, 24) : []).flatMap(
    (value) => {
      const parsed = hitSchema.safeParse(value);
      if (!parsed.success) return [];
      const hit = parsed.data as SearchHit;
      return [
        {
          kind: "knowledge" as const,
          key: `knowledge:${hit.indexKind ?? "legacy"}:${hit.indexVersionId ?? 0}:${hit.chunkId}`,
          digest: evidenceDigest(hit),
          data: hit,
        },
      ];
    },
  );
}
export function makeContextBlock(
  resources: ContextResource[],
  metadata: Omit<RuntimeContextBlock, "version" | "resources" | "occurredAt">,
  maxChars = 24000,
): RuntimeContextBlock | undefined {
  if (
    !metadata.conversationId ||
    !/^[a-z][a-z0-9_]{0,79}$/u.test(metadata.source)
  )
    return;
  const selected: ContextResource[] = [];
  let used = 0;
  for (const raw of resources.slice(0, 24)) {
    const resource = normalizeResource(raw);
    if (!resource) continue;
    const chars = JSON.stringify(resource).length;
    if (used + chars > maxChars) continue;
    selected.push(resource);
    used += chars;
  }
  return selected.length
    ? {
        ...metadata,
        version: 1,
        occurredAt: new Date().toISOString(),
        resources: selected,
      }
    : undefined;
}
export function normalizeResource(value: unknown): ContextResource | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as ContextResource;
  if (r.kind === "knowledge") {
    const normalized = knowledgeResources({
      success: true,
      content: "",
      data: { hits: [r.data] },
    })[0];
    if (normalized?.kind === "knowledge" && normalized.digest === r.digest)
      return normalized;
  }
}
/** Snapshots are already owner-scoped by the conversation service; reject mismatched envelopes too. */
export function readContextBlocks(
  value: unknown,
  conversationId: string,
): RuntimeContextBlock[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const b = raw as RuntimeContextBlock;
    if (
      b.version !== 1 ||
      b.conversationId !== conversationId ||
      !["model", "preload", "host"].includes(b.origin) ||
      typeof b.source !== "string" ||
      !Array.isArray(b.resources)
    )
      return [];
    const block = makeContextBlock(b.resources, {
      conversationId,
      source: b.source,
      origin: b.origin,
      ...(typeof b.traceId === "string" ? { traceId: b.traceId } : {}),
      ...(b.origin === "model" && typeof b.toolCallId === "string"
        ? { toolCallId: b.toolCallId }
        : {}),
    });
    return block
      ? [
          {
            ...block,
            occurredAt:
              typeof b.occurredAt === "string"
                ? b.occurredAt
                : block.occurredAt,
          },
        ]
      : [];
  });
}
/** Read older traces without rewriting their original records or inventing native tool calls. */
export function legacyContextBlocks(
  snapshot: Record<string, unknown>,
  conversationId: string,
  traceId?: string,
): RuntimeContextBlock[] {
  const blocks: RuntimeContextBlock[] = [];
  for (const raw of Array.isArray(snapshot.agentTranscript)
    ? snapshot.agentTranscript
    : []) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as {
      role?: string;
      toolName?: string;
      content?: string;
    };
    if (
      message.role !== "tool" ||
      message.toolName !== "search_knowledge" ||
      typeof message.content !== "string"
    )
      continue;
    try {
      const parsed = JSON.parse(message.content);
      const data =
        parsed &&
        typeof parsed.result === "object" &&
        parsed.result !== null &&
        !Array.isArray(parsed.result)
          ? parsed.result
          : parsed;
      const block = makeContextBlock(
        knowledgeResources({ success: true, content: "", data }),
        {
          conversationId,
          traceId,
          source: "search_knowledge",
          origin: "model",
        },
      );
      if (block) blocks.push(block);
    } catch {
      /* Truncated or failed historical results are not reusable evidence. */
    }
  }
  return blocks;
}
