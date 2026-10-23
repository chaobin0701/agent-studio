/** JSON-only contracts shared by single Agents and authorized member Agents. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: AgentAction[];
};
export type AgentAction = { id: string; name: string; arguments: JsonObject };
export type AgentReference = {
  kind: string;
  id: string;
  title?: string;
  metadata?: JsonObject;
};
export type AgentArtifact = { kind: string; id?: string; delivery?: "immediate"; data: JsonValue };
export type AgentUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};
export type AgentTaskInput = {
  messages: AgentMessage[];
  task?: string;
  /** Optional contract for structured data, never authority or routing. */
  outputSchema?: JsonObject;
  outputContract?: {mode:'text'|'json';source:'legacy'|'agent'|'request';schemaHash:string|null;agentVersionId:number};
  attachments?: AgentReference[];
  /** IDs/hashes only. Resolved providers and credentials belong to execution context. */
  versions: JsonObject;
  limits: {
    maxDecisions: number;
    maxToolCalls: number;
    maxDurationMs?: number;
    /** Shared across the entry Agent, members, Skills and actual retries. */
    maxModelCalls?: number;
    maxTotalTokens?: number;
  };
};
export type AgentFinalOutput = {
  status: "completed" | "refused";
  answer: string;
  structured?: JsonValue;
  references: AgentReference[];
  artifacts: AgentArtifact[];
  usage: AgentUsage;
};
export const DEFAULT_AGENT_RUN_DURATION_MS = 180000;
/** Capability/legacy Trace classification only, never a generic model router. */
export type AgentExecutionChannel =
  | "tools"
  | "skill_guidance"
  | "skill_task"
  | "agent_task";
export class AgentRunLimitError extends Error {
  readonly code = "agent_budget_exceeded";
  constructor() {
    super("Agent execution budget exceeded");
    this.name = "AgentRunLimitError";
  }
}

/** Reject non-JSON state rather than silently losing Maps, services or signals. */
export function assertSerializable(
  value: unknown,
  ancestors = new Set<unknown>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || ancestors.has(value))
    throw new TypeError("Agent state must be acyclic JSON");
  const plain =
    Array.isArray(value) ||
    Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null;
  if (!plain)
    throw new TypeError(
      "Agent state cannot contain service instances, Maps, Sets or signals",
    );
  ancestors.add(value);
  for (const child of Object.values(value))
    assertSerializable(child, ancestors);
  ancestors.delete(value);
}
