import type { AgentEvent } from '../channels/agent-event';

export type MessageBus = {
  publish(event: AgentEvent): Promise<void>;
  publishEvent(event: AgentEvent): void;
  subscribe<T extends AgentEvent['type']>(eventType: T, handler: (event: Extract<AgentEvent, { type: T }>) => Promise<void> | void): () => void;
};
