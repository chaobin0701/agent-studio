import { z } from "zod";
import { ToolContext } from "./tool-context";
import { ToolResult } from "./tool-result";
import type { ContextProjector } from "../context/context-contribution";
import type { AgentToolCapability } from "./tool-capabilities";
import type { AgentExecutionChannel } from "../agent/execution-contract";

export type AgentToolPlanning = {
  /** Independent reads can share a response. A successful false tool requires replanning before subsequent calls. */
  readonly canBatch: boolean;
  /** Human-readable dependency hint for the planner; execution still validates inputs. */
  readonly dependency?: string;
  /** Whether transient failures on this tool can be safely retried automatically. Defaults to true for read-only tools. */
  readonly isIdempotent?: boolean;
};

/** A business capability that an agent may execute by name. */
export interface AgentTool<TInput = unknown> {
  /** Host-resolved execution semantics, never supplied by model arguments. */
  readonly execution?: {
    channel: AgentExecutionChannel;
    source: "platform" | "builtin" | "http" | "mcp";
    toolVersionId?: number;
    mcpServerId?: number;
    /** Immutable trusted specialized graph identity, not model-supplied routing. */
    workflow?: {
      key: string;
      version: string;
      requiredTools: readonly string[];
      requiresAgentContext?: boolean;
    };
  };
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  /** Provider-visible schema for managed tools; execution still validates inputSchema. */
  readonly parameters?: Record<string, unknown>;
  readonly runtimeLimits?: { maxRetries: number; timeoutMs: number };
  /** Stable business capability; adapter-specific tool names stay at the edge. */
  readonly capabilities?: readonly AgentToolCapability[];
  readonly planning?: AgentToolPlanning;
  /** Trusted opt-in projection of safe result fields into persistent model context. */
  readonly contributeContext?: ContextProjector;
  /** Trusted opt-in, request-local successful read cache; never enabled by model/config alone. */
  readonly resultCacheKey?: (validatedInput: unknown) => string | undefined;

  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
}
