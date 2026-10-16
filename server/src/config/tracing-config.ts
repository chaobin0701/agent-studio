import { z } from "zod";
import type { PhoenixTracingOptions } from "../observability/execution-tracer";

/** Only local/private collectors. Never fall back to a vendor cloud or ambient OTEL URL. */
export function localPhoenixUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    const parts = host.split(".").map(Number);
    const privateIPv4 =
      parts.length === 4 &&
      parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
        (parts[0] === 192 && parts[1] === 168));
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (["localhost", "::1", "phoenix", "host.docker.internal"].includes(host) ||
        privateIPv4)
    );
  } catch {
    return false;
  }
}
const localUrl = z
  .string()
  .url()
  .refine(localPhoenixUrl, "Phoenix must be a local/private endpoint");
const schema = z.object({
  enabled: z.preprocess(
    (value) =>
      value === undefined
        ? true
        : value === "true"
          ? true
          : value === "false"
            ? false
            : value,
    z.boolean(),
  ),
  endpoint: localUrl.default("http://127.0.0.1:6006/v1/traces"),
  webUrl: localUrl.default("http://127.0.0.1:6006"),
  apiKey: z.string().trim().default(""),
  project: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.-]{1,100}$/iu)
    .default("generic-agents"),
  sampleRate: z.coerce.number().min(0).max(1).default(1),
  timeoutMs: z.coerce.number().int().min(100).max(10000).default(2000),
  queueLimit: z.coerce.number().int().min(1).max(10000).default(1000),
});
export function readTracingEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): PhoenixTracingOptions {
  const parsed = schema.safeParse({
    enabled: env.PHOENIX_TRACING,
    endpoint: env.PHOENIX_COLLECTOR_ENDPOINT,
    webUrl: env.PHOENIX_WEB_URL,
    apiKey: env.PHOENIX_API_KEY,
    project: env.PHOENIX_PROJECT_NAME,
    sampleRate: env.PHOENIX_SAMPLE_RATE,
    timeoutMs: env.PHOENIX_TIMEOUT_MS,
    queueLimit: env.PHOENIX_QUEUE_LIMIT,
  });
  if (!parsed.success)
    throw new Error(
      `Invalid tracing configuration fields: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return parsed.data;
}
