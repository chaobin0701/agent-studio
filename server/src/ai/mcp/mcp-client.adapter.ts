import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult, type ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export class McpClientAdapter {
  private readonly client: Client;
  private readonly clientTransport: InMemoryTransport;
  private readonly serverTransport: InMemoryTransport;
  private connected = false;

  private constructor(
    private readonly server: McpServer,
    clientTransport: InMemoryTransport,
    serverTransport: InMemoryTransport,
  ) {
    this.client = new Client({ name: 'agent-studio', version: '0.1.0' });
    this.clientTransport = clientTransport;
    this.serverTransport = serverTransport;
  }

  static async connect(server: McpServer): Promise<McpClientAdapter> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const adapter = new McpClientAdapter(server, clientTransport, serverTransport);
    await server.connect(serverTransport);
    await adapter.client.connect(clientTransport);
    adapter.connected = true;
    return adapter;
  }

  async listTools(): Promise<ListToolsResult> {
    this.assertConnected();
    return this.client.listTools();
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<CallToolResult> {
    this.assertConnected();
    const result = await this.client.callTool({ name, arguments: arguments_ }, CallToolResultSchema);
    if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
      throw new Error('MCP tool returned a non-standard task result');
    }
    return result as CallToolResult;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.close();
    await this.server.close();
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('MCP client is not connected');
  }
}
