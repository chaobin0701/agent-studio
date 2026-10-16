import { Injectable, Logger } from '@nestjs/common';
import type { AgentEvent } from '../channels/agent-event';
import type { MessageBus } from './message-bus';

type Handler = (event: AgentEvent) => Promise<void> | void;

@Injectable()
export class InMemoryMessageBus implements MessageBus {
  private readonly logger = new Logger(InMemoryMessageBus.name);
  private readonly handlers = new Map<AgentEvent['type'], Handler[]>();

  async publish(event: AgentEvent): Promise<void> {
    const handlers = [...(this.handlers.get(event.type) ?? [])];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.warn(`MessageBus subscriber failed for ${event.type}: ${error instanceof Error ? error.name : 'unknown_error'}`);
      }
    }
  }

  publishEvent(event: AgentEvent): void {
    void this.publish(event).catch((error) => this.logger.warn(`MessageBus delivery failed: ${error instanceof Error ? error.name : 'unknown_error'}`));
  }

  subscribe<T extends AgentEvent['type']>(eventType: T, handler: (event: Extract<AgentEvent, { type: T }>) => Promise<void> | void): () => void {
    const current = this.handlers.get(eventType) ?? [];
    const internal = handler as Handler;
    current.push(internal);
    this.handlers.set(eventType, current);
    return () => {
      const registered = this.handlers.get(eventType) ?? [];
      const index = registered.indexOf(internal);
      if (index >= 0) registered.splice(index, 1);
      if (!registered.length) this.handlers.delete(eventType);
    };
  }
}
