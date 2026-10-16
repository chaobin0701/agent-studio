import { Injectable, Logger } from '@nestjs/common';
import type { McpPluginDefinition } from './mcp-plugin.types';
import { McpClientAdapter } from './mcp-client.adapter';

export class DuplicateMcpPluginError extends Error {}
export class UnknownMcpPluginError extends Error {}

@Injectable()
export class McpPluginRegistry {
  private readonly logger = new Logger(McpPluginRegistry.name);
  private readonly definitions = new Map<string, McpPluginDefinition>();
  private readonly clients = new Map<string, McpClientAdapter>();

  register(plugin: McpPluginDefinition): void {
    if (this.definitions.has(plugin.id)) throw new DuplicateMcpPluginError(`MCP plugin already registered: ${plugin.id}`);
    this.definitions.set(plugin.id, plugin);
  }

  get(id: string): McpPluginDefinition {
    const plugin = this.definitions.get(id);
    if (!plugin) throw new UnknownMcpPluginError(`Unknown MCP plugin: ${id}`);
    return plugin;
  }

  list(): McpPluginDefinition[] { return [...this.definitions.values()]; }

  client(id: string): McpClientAdapter {
    const client = this.clients.get(id);
    if (!client) throw new UnknownMcpPluginError(`MCP plugin is not started: ${id}`);
    return client;
  }

  async start(id: string): Promise<McpClientAdapter | null> {
    const plugin = this.get(id);
    if (!plugin.enabled) return null;
    if (this.clients.has(id)) return this.clients.get(id)!;
    try {
      const client = await McpClientAdapter.connect(plugin.createServer());
      this.clients.set(id, client);
      return client;
    } catch (error) {
      this.logger.warn(`MCP plugin failed to start: ${id} (${error instanceof Error ? error.name : 'unknown_error'})`);
      return null;
    }
  }

  async stop(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    await client.close();
  }

  async stopAll(): Promise<void> {
    for (const id of this.clients.keys()) await this.stop(id);
  }
}
