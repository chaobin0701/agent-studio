import type { LlmToolCall } from '../ai/providers/provider.types';

export type AgentTranscriptToolCall = {
  id: string;
  name: LlmToolCall['name'];
  arguments: Record<string, unknown>;
};

/**
 * Provider-neutral record of the messages that make up one Agent turn.
 * The persisted transcript is the source record; the native Chat context boundary decides how
 * much of it is sent to a model in a later context-governance phase.
 */
export type AgentTranscriptMessage = {
  conversationId: string;
  traceId: string;
  sequence: number;
  createdAt: string;
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: AgentTranscriptToolCall[];
  toolCallId?: string;
  toolName?: string;
  citationIds?: number[];
};

export const TRANSCRIPT_VERSION = 1;

export function transcriptMessageBase(
  conversationId: string | undefined,
  traceId: string | undefined,
  sequence: number,
): Pick<AgentTranscriptMessage, 'conversationId' | 'traceId' | 'sequence' | 'createdAt'> {
  return {
    conversationId: conversationId ?? 'unknown',
    traceId: traceId ?? 'pending',
    sequence,
    createdAt: new Date().toISOString(),
  };
}

export function isAgentTranscriptMessage(value: unknown): value is AgentTranscriptMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.role === 'user' || item.role === 'assistant' || item.role === 'tool')
    && typeof item.conversationId === 'string'
    && typeof item.traceId === 'string'
    && typeof item.sequence === 'number'
    && typeof item.createdAt === 'string';
}

export function flattenTranscript(values: unknown[]): AgentTranscriptMessage[] {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter(isAgentTranscriptMessage)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence);
}
