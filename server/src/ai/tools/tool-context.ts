import { createHash } from "node:crypto";

/** Canonical across JSONB key ordering; array order remains semantically significant. */
export function toolArgumentsHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item)).digest("hex");
}

/** Per-run context passed to a tool. It is intentionally not a chat history. */
export interface ToolContext {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly userId?: string;
  readonly tenantId?: string;
  readonly permissions: readonly string[];
  readonly enabledSkillIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly approvedTools?: readonly string[];
  /** Host-created one-call grant; never accepted from public tool arguments. */
  readonly toolApproval?: {
    toolCallId: string;
    toolVersionId: number;
    argumentsHash: string;
  };
  readonly interactionAnswer?: { toolCallId: string; text: string; optionId?: string };
  readonly state: Map<string, unknown>;
}
