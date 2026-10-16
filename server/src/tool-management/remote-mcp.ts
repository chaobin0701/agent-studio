import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpConnectionConfig, ToolCredential } from "./tool-config";
import { toolFetch } from "./network";

export type McpDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};
export function contractHash(value: unknown): string {
  const ordered = (input: any): any =>
    Array.isArray(input)
      ? input.map(ordered)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, ordered(input[key])]),
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}
export function mcpResourceKey(serverKey: string, toolName: string): string {
  return (
    `mcp_${serverKey}_${toolName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(
      0,
      65,
    ) +
    "_" +
    contractHash([serverKey, toolName]).slice(0, 10)
  );
}
export async function withRemoteMcp<T>(
  config: McpConnectionConfig,
  credential: ToolCredential | undefined,
  signal: AbortSignal | undefined,
  work: (client: Client) => Promise<T>,
  fetchImpl: typeof fetch = toolFetch,
): Promise<T> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  const headers: Record<string, string> = {};
  if (credential)
    headers[
      credential.kind === "bearer" ? "Authorization" : credential.header
    ] =
      credential.kind === "bearer"
        ? `Bearer ${credential.secret}`
        : credential.secret;
  const origin = new URL(config.url).origin;
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers, redirect: "error" },
    fetch: async (input, init) => {
      const url = new URL(input instanceof URL ? input.href : input);
      if (url.origin !== origin) throw new Error("mcp_origin_rejected");
      return fetchImpl(input, {
        ...init,
        redirect: "error",
        signal: init?.signal
          ? AbortSignal.any([combined, init.signal])
          : combined,
      });
    },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client({ name: "agent-studio", version: "1.0.0" });
  const abort = () => {
    void client.close().catch(() => {});
  };
  combined.addEventListener("abort", abort, { once: true });
  try {
    await client.connect(transport, {
      signal: combined,
      timeout: config.timeoutMs,
    });
    return await work(client);
  } finally {
    combined.removeEventListener("abort", abort);
    await client.close().catch(() => {});
  }
}
export async function discoverMcp(
  client: Client,
  signal?: AbortSignal,
): Promise<McpDefinition[]> {
  const tools: McpDefinition[] = [];
  const cursors = new Set<string>();
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      signal,
    });
    for (const tool of page.tools) {
      if (names.has(tool.name)) throw new Error("mcp_duplicate_tool");
      names.add(tool.name);
      if (
        !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
        tool.inputSchema.type !== "object"
      )
        throw new Error("mcp_invalid_tool_contract");
      z.fromJSONSchema(tool.inputSchema as any);
      if (tool.outputSchema) z.fromJSONSchema(tool.outputSchema as any);
      tools.push({
        name: tool.name,
        description: (tool.description ?? tool.name).slice(0, 2000),
        inputSchema: tool.inputSchema as Record<string, unknown>,
        ...(tool.outputSchema
          ? { outputSchema: tool.outputSchema as Record<string, unknown> }
          : {}),
      });
      if (tools.length > 300) throw new Error("mcp_tool_limit");
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("mcp_repeated_cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}
export async function callMcp(
  client: Client,
  definition: McpDefinition,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const current = (await discoverMcp(client, signal)).find(
    (tool) => tool.name === definition.name,
  );
  if (!current || contractHash(current) !== contractHash(definition))
    throw new Error("mcp_contract_changed");
  return (await client.callTool(
    { name: definition.name, arguments: input },
    CallToolResultSchema,
    { signal },
  )) as CallToolResult;
}
