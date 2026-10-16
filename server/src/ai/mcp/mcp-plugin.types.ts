import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentTool, AgentToolPlanning } from "../tools/agent-tool";
import type { ContextProjector } from "../context/context-contribution";
import type { AgentToolCapability } from "../tools/tool-capabilities";

export type McpPluginDefinition = {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
  /** Trusted scheduling metadata from static plugin registration, not model input. */
  readonly toolPlanning?: Readonly<Record<string, AgentToolPlanning>>;
  readonly toolContextProjectors?: Readonly<Record<string, ContextProjector>>;
  readonly toolResultCacheKeys?: Readonly<
    Record<string, NonNullable<AgentTool["resultCacheKey"]>>
  >;
  readonly toolCapabilities?: Readonly<
    Record<string, readonly AgentToolCapability[]>
  >;
  readonly createServer: () => McpServer;
};
