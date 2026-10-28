import type { LlmMessage } from "../ai/providers/provider.types";
import type { LlmRequest } from "../ai/providers/provider.types";

const maxPayloadChars = 4_000_000;
const sensitiveKey =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential|cookie|private[_-]?key|(?:^|[_-])token$)/iu;
const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu,
  /\b(?:sk|rk|pk|lsv2)_[A-Za-z0-9_-]{12,}\b/giu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/giu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/giu,
  /\bAIza[\w-]{30,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /:\/\/[^\s/:@]+:[^\s/@]+@/gu,
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credential)\s*[:=]\s*)[^\s,;]+/giu,
];

function cleanString(value: string): string {
  let result = value;
  for (const pattern of secretPatterns)
    result = result.replace(pattern, (_match, prefix: string | undefined) =>
      prefix ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  return result;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth limited]";
  if (typeof value === "string") return cleanString(value);
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    result[key] = sensitiveKey.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
  return result;
}

export function traceContentValue(value: unknown): string {
  const serialized = JSON.stringify(sanitize(value)) ?? "null";
  if (serialized.length <= maxPayloadChars) return serialized;
  return JSON.stringify({
    truncated: true,
    preview: serialized.slice(0, maxPayloadChars - 64),
  });
}

export function traceModelMessages(messages: LlmMessage[]): unknown {
  return sanitize(messages);
}

export function traceModelRequest(request: LlmRequest): unknown {
  return sanitize({
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    responseFormat: request.responseFormat,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    images: request.images?.map(({ id, mimeType, width, height, data }) => ({
      id,
      mimeType,
      width,
      height,
      byteLength: data.byteLength,
      content: "[image bytes omitted]",
    })),
  });
}
