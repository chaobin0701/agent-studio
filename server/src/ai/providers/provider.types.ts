export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: LlmRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A provider-neutral description of the structured response contract.
 * OpenAI-compatible providers map this to `response_format` at the wire edge.
 */
export type LlmResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: LlmResponseFormat;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Host-validated live input. Never part of the native/persisted transcript. */
  images?: readonly LlmImage[];
}

export type LlmImage = {
  id: string;
  mimeType: "image/jpeg";
  data: Buffer;
  width: number;
  height: number;
};

export type LlmStreamEvent =
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "completed"; usage: LlmUsage; finishReason: string | null };

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  usage: LlmUsage;
  model: string;
  durationMs: number;
}
