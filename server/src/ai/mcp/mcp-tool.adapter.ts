import { z } from "zod";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool, AgentToolPlanning } from "../tools/agent-tool";
import type { ToolContext } from "../tools/tool-context";
import type { ToolResult } from "../tools/tool-result";
import type { McpClientAdapter } from "./mcp-client.adapter";
import type { ContextProjector } from "../context/context-contribution";
import type { AgentToolCapability } from "../tools/tool-capabilities";

export type McpToolEvent = {
  type: "started" | "completed" | "failed";
  pluginId: string;
  toolName: string;
  errorCode?: string;
};

export function adaptMcpTool(
  pluginId: string,
  client: McpClientAdapter,
  tool: McpTool,
  onEvent?: (event: McpToolEvent, context: ToolContext) => void,
  planning?: AgentToolPlanning,
  contributeContext?: ContextProjector,
  capabilities?: readonly AgentToolCapability[],
  resultCacheKey?: AgentTool["resultCacheKey"],
): AgentTool {
  const name = `mcp_${pluginId}_${tool.name}`;
  return {
    name,
    description: tool.description ?? `MCP tool ${tool.name}`,
    inputSchema: jsonSchemaToZod(tool.inputSchema),
    ...(capabilities ? { capabilities } : {}),
    ...(planning ? { planning } : {}),
    ...(contributeContext ? { contributeContext } : {}),
    ...(resultCacheKey ? { resultCacheKey } : {}),
    async execute(
      input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult> {
      onEvent?.({ type: "started", pluginId, toolName: tool.name }, _context);
      try {
        const result = await client.callTool(tool.name, input);
        const content = result.content
          .filter(
            (item): item is { type: "text"; text: string } =>
              item.type === "text",
          )
          .map((item) => item.text)
          .join("\n");
        if (result.isError) {
          onEvent?.(
            {
              type: "failed",
              pluginId,
              toolName: tool.name,
              errorCode: "mcp_tool_failed",
            },
            _context,
          );
          return {
            success: false,
            content: content || "MCP_TOOL_FAILED",
            errorCode: "mcp_tool_failed",
          };
        }
        const normalized = {
          success: true,
          content: content || JSON.stringify(result.structuredContent ?? {}),
          data: result.structuredContent,
          metadata: { mcpPluginId: pluginId, mcpToolName: tool.name },
        };
        onEvent?.(
          { type: "completed", pluginId, toolName: tool.name },
          _context,
        );
        return normalized;
      } catch {
        onEvent?.(
          {
            type: "failed",
            pluginId,
            toolName: tool.name,
            errorCode: "mcp_tool_unavailable",
          },
          _context,
        );
        return {
          success: false,
          content: "MCP_TOOL_UNAVAILABLE",
          errorCode: "mcp_tool_unavailable",
        };
      }
    },
  };
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (schema.type !== "object") return z.record(z.string(), z.unknown());
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    let field: z.ZodTypeAny =
      value.type === "string"
        ? z.string()
        : value.type === "number"
          ? z.number()
          : value.type === "boolean"
            ? z.boolean()
            : z.unknown();
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape).strict();
}
