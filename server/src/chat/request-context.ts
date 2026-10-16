import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

/** Caller-owned JSON hints, never a tool grant, trusted resource or system prompt. */
export type RequestContext = { data?: Record<string, unknown> };
export type MessageContext = RequestContext;
const schema = z
  .object({ data: z.record(z.string().min(1).max(100), z.json()).optional() })
  .strict();
const unsafeKey = (value: unknown, depth = 0): boolean => {
  if (depth > 8) return true;
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      ["__proto__", "prototype", "constructor"].includes(key) ||
      unsafeKey(item, depth + 1),
  );
};
export function normalizeRequestContext(
  value?: unknown,
  _question?: string,
): RequestContext {
  const parsed = schema.safeParse(value ?? {});
  if (
    !parsed.success ||
    unsafeKey(value) ||
    JSON.stringify(parsed.data).length > 8000
  )
    throw new BadRequestException(
      "上下文须为不超过 8000 字符、深度不超过 8 的 JSON data 对象",
    );
  return parsed.data.data && Object.keys(parsed.data.data).length
    ? parsed.data
    : {};
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function contextFingerprint(value?: RequestContext): string {
  const context = normalizeRequestContext(value);
  return Object.keys(context).length
    ? JSON.stringify(canonical(context))
    : "[]";
}
export function messageContext(value?: unknown): MessageContext {
  // Old stored context remains historical data, never elevated into new requests.
  try {
    return normalizeRequestContext(value);
  } catch {
    return {};
  }
}
