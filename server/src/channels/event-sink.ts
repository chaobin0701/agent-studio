import type { AgentEvent } from './agent-event';

export type EventSink = {
  emit(event: AgentEvent): Promise<void> | void;
};
