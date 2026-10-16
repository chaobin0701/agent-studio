import type { ChannelName } from './channel.types';

export type AgentEventBase = {
  eventId: string;
  channel: ChannelName;
  conversationId: string;
  messageId: string;
  runId: string;
  occurredAt: string;
  visibility: 'public' | 'internal' | 'admin';
};

export type AgentEvent =
  | (AgentEventBase & { type: 'message.received'; question: string })
  | (AgentEventBase & { type: 'run.started' })
  | (AgentEventBase & { type: 'mcp.tool.started' | 'mcp.tool.completed' | 'mcp.tool.failed'; pluginId: string; toolName: string; errorCode?: string })
  | (AgentEventBase & { type: 'message.completed'; answer: string; refused: boolean; citations: unknown[] })
  | (AgentEventBase & { type: 'run.failed'; errorCode: string });
