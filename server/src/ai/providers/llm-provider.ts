import { LlmRequest, LlmResponse, LlmStreamEvent } from './provider.types';

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export interface LlmProvider {
  readonly model: string;
  readonly implementationVersion?: string;
  readonly maxOutputTokens?: number;
  readonly contextWindowTokens?: number;
  chat(request: LlmRequest): Promise<LlmResponse>;
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}
