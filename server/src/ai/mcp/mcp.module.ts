import { Module, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ToolsModule } from "../tools/tools.module";
import { ToolRegistry } from "../tools/tool-registry";
import { McpPluginRegistry } from "./mcp-plugin-registry";
import { adaptMcpTool } from "./mcp-tool.adapter";
import { InMemoryMessageBus } from "../../message-bus/in-memory-message-bus";
import { randomUUID } from "node:crypto";

@Module({
  imports: [ToolsModule],
  providers: [McpPluginRegistry],
  exports: [McpPluginRegistry],
})
export class McpModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly plugins: McpPluginRegistry,
    private readonly registry: ToolRegistry,
    private readonly messageBus: InMemoryMessageBus,
  ) {}

  async onModuleInit(): Promise<void> {
    // Only code-installed extensions register in-process plugins. The generic
    // protocol module neither imports a business service nor grants Agent access.
    for (const plugin of this.plugins.list()) {
      const client = await this.plugins.start(plugin.id);
      if (!client) continue;
      const discovered = await client.listTools();
      for (const tool of discovered.tools)
        this.registry.register(
          adaptMcpTool(
            plugin.id,
            client,
            tool,
            (event, context) => {
              this.messageBus.publishEvent({
                eventId: randomUUID(),
                channel: "api",
                conversationId: context.sessionId ?? "unknown",
                messageId: "unknown",
                runId: context.traceId ?? "unknown",
                occurredAt: new Date().toISOString(),
                visibility: "internal",
                type: `mcp.tool.${event.type}` as
                  | "mcp.tool.started"
                  | "mcp.tool.completed"
                  | "mcp.tool.failed",
                pluginId: event.pluginId,
                toolName: event.toolName,
                ...(event.errorCode ? { errorCode: event.errorCode } : {}),
              });
            },
            plugin.toolPlanning?.[tool.name],
            plugin.toolContextProjectors?.[tool.name],
            plugin.toolCapabilities?.[tool.name],
            plugin.toolResultCacheKeys?.[tool.name],
          ),
        );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.plugins.stopAll();
  }
}
