import { createHash } from "node:crypto";
import {
  safeTracingUrl,
  type ResolvedTracingOptions,
} from "../config/tracing-config";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
export type ExternalTraceMapping = {
  schemaVersion: 1;
  provider: "langsmith";
  enabled: boolean;
  traceId: string;
  runId: string;
  rootRunId?: string;
  destination: string;
};
export function destinationId(o: ResolvedTracingOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        o.endpoint,
        o.workspaceId ?? null,
        o.project ?? null,
        o.agentIdentifier ?? null,
        o.environment ?? null,
      ]),
    )
    .digest("hex");
}
export function langSmithRunId(traceId: string, spanId: string): string {
  const b = createHash("sha256")
    .update(traceId + ":" + spanId)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 15) | 80;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20),
  ].join("-");
}
export function safeExternalTrace(
  value: unknown,
): ExternalTraceMapping | undefined {
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  if (
    v.schemaVersion !== 1 ||
    v.provider !== "langsmith" ||
    typeof v.enabled !== "boolean" ||
    typeof v.traceId !== "string" ||
    !/^[a-f0-9]{32}$/iu.test(v.traceId) ||
    /^0+$/u.test(v.traceId) ||
    typeof v.runId !== "string" ||
    !uuid.test(v.runId) ||
    (v.rootRunId !== undefined &&
      (typeof v.rootRunId !== "string" || !uuid.test(v.rootRunId))) ||
    typeof v.destination !== "string" ||
    !/^[a-f0-9]{64}$/u.test(v.destination)
  )
    return;
  return {
    schemaVersion: 1,
    provider: "langsmith",
    enabled: v.enabled,
    traceId: v.traceId,
    runId: v.runId,
    ...(typeof v.rootRunId === "string" ? { rootRunId: v.rootRunId } : {}),
    destination: v.destination,
  };
}
export function safeLangSmithAppPath(
  webUrl: string,
  path: unknown,
  runId: string,
): string | null {
  if (
    !safeTracingUrl(webUrl) ||
    !uuid.test(runId) ||
    typeof path !== "string" ||
    !path.startsWith("/o/")
  )
    return null;
  try {
    const base = new URL(webUrl),
      url = new URL(path, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash)
      return null;
    // Cloud app_path includes trace/time navigation hints. Validate and drop
    // those hints; the backend returns only the pinned canonical run route.
    for (const [key, value] of url.searchParams)
      if (
        (key === "trace_id" && !uuid.test(value)) ||
        (key === "start_time" &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z?$/u.test(
            value,
          ) ||
            Number.isNaN(Date.parse(value)))) ||
        !["trace_id", "start_time"].includes(key)
      )
        return null;
    if (
      !new RegExp(
        "^/o/[a-f0-9-]{36}/projects/p/[a-f0-9-]{36}/r/" + runId + "$",
        "iu",
      ).test(url.pathname)
    )
      return null;
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}
export function configuredTraceUrl(
  o: ResolvedTracingOptions,
  runId: string,
): string | null {
  return o.workspaceId && o.projectId
    ? safeLangSmithAppPath(
        o.webUrl,
        "/o/" + o.workspaceId + "/projects/p/" + o.projectId + "/r/" + runId,
        runId,
      )
    : null;
}
