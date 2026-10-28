import { z } from "zod";
export type TracingOptions = {
  enabled: boolean;
  contentEnabled?: boolean;
  endpoint?: string;
  webUrl?: string;
  apiKey?: string;
  workspaceId?: string;
  project?: string;
  projectId?: string;
  agentIdentifier?: string;
  environment?: string;
  sampleRate?: number;
  timeoutMs?: number;
  queueLimit?: number;
};
const cloudHosts = new Map([
  ["api.smith.langchain.com", "smith.langchain.com"],
  ["eu.api.smith.langchain.com", "eu.smith.langchain.com"],
  ["apac.api.smith.langchain.com", "apac.smith.langchain.com"],
  ["aws.api.smith.langchain.com", "aws.smith.langchain.com"],
]);
export function safeTracingUrl(value: string): boolean {
  try {
    const u = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (u.protocol === "https:" || (u.protocol === "http:" && local))
    );
  } catch {
    return false;
  }
}
const cleanText = z
  .string()
  .trim()
  .max(200)
  .refine((v) => !/[\r\n\u0000-\u001f\u007f]/u.test(v));
const uuid = z.string().uuid().optional();
const schema = z
  .object({
    enabled: z.preprocess(
      (v) =>
        v === undefined
          ? false
          : v === "true"
            ? true
            : v === "false"
              ? false
              : v,
      z.boolean(),
    ),
    contentEnabled: z.preprocess(
      (v) =>
        v === undefined
          ? false
          : v === "true"
            ? true
            : v === "false"
              ? false
              : v,
      z.boolean(),
    ),
    endpoint: z
      .string()
      .url()
      .refine(safeTracingUrl)
      .default("https://api.smith.langchain.com"),
    webUrl: z.string().url().refine(safeTracingUrl).optional(),
    apiKey: cleanText.default(""),
    workspaceId: uuid,
    project: cleanText.optional(),
    projectId: uuid,
    agentIdentifier: z
      .string()
      .regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
      .optional(),
    environment: z
      .enum(["local", "development", "staging", "production"])
      .optional(),
    sampleRate: z.coerce.number().min(0).max(1).default(1),
    timeoutMs: z.coerce.number().int().min(100).max(10000).default(2000),
    queueLimit: z.coerce.number().int().min(1).max(10000).default(1000),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && !v.apiKey)
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "Required when enabled",
      });
    const agent = Boolean(v.agentIdentifier || v.environment);
    if (
      agent &&
      (!v.agentIdentifier || !v.environment || v.project || v.projectId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["agentIdentifier"],
        message: "Choose project or complete agent/environment",
      });
    if (v.enabled && !agent && !v.project)
      ctx.addIssue({
        code: "custom",
        path: ["project"],
        message: "Destination required",
      });
    if (
      v.enabled &&
      safeTracingUrl(v.endpoint) &&
      !cloudHosts.has(new URL(v.endpoint).hostname) &&
      !v.webUrl
    )
      ctx.addIssue({
        code: "custom",
        path: ["webUrl"],
        message: "Self-hosted UI URL required",
      });
  });
export function normalizeTracingOptions(options: TracingOptions) {
  const parsed = schema.safeParse(options);
  if (!parsed.success)
    throw new Error(
      "Invalid tracing configuration fields: " +
        [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(
          ", ",
        ),
    );
  const value = parsed.data,
    api = new URL(value.endpoint);
  api.pathname = api.pathname
    .replace(/\/$/u, "")
    .replace(/\/otel(?:\/v1\/traces)?$/u, "");
  const endpoint = api.href.replace(/\/$/u, "");
  return {
    ...value,
    endpoint,
    collectorEndpoint: endpoint + "/otel/v1/traces",
    webUrl: (
      value.webUrl ?? "https://" + (cloudHosts.get(api.hostname) ?? api.host)
    ).replace(/\/$/u, ""),
  };
}
export type ResolvedTracingOptions = ReturnType<typeof normalizeTracingOptions>;
export function readTracingEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTracingOptions {
  const get = (key: string) =>
    env["AGENT_STUDIO_LANGSMITH_" + key] || undefined;
  return normalizeTracingOptions({
    enabled: get("ENABLED") as unknown as boolean,
    contentEnabled: get("CONTENT_ENABLED") as unknown as boolean,
    endpoint: get("ENDPOINT"),
    webUrl: get("WEB_URL"),
    apiKey: get("API_KEY"),
    workspaceId: get("WORKSPACE_ID"),
    project: get("PROJECT"),
    projectId: get("PROJECT_ID"),
    agentIdentifier: get("AGENT_ID"),
    environment: get("ENVIRONMENT"),
    sampleRate: get("SAMPLE_RATE") as unknown as number,
    timeoutMs: get("TIMEOUT_MS") as unknown as number,
    queueLimit: get("QUEUE_LIMIT") as unknown as number,
  });
}
