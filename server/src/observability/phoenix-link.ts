import { localPhoenixUrl } from "../config/tracing-config";
import type { PhoenixTracingOptions } from "./execution-tracer";

/** Never accept a stored arbitrary URL: reconstruct it from the configured local deployment. */
export function phoenixTraceUrl(
  options: PhoenixTracingOptions,
  traceId: unknown,
): string | null {
  if (
    typeof traceId !== "string" ||
    !/^[0-9a-f]{32}$/iu.test(traceId) ||
    /^0+$/u.test(traceId)
  )
    return null;
  const base = options.webUrl ?? "http://127.0.0.1:6006";
  if (!localPhoenixUrl(base)) return null;
  return `${base.replace(/\/$/u, "")}/redirects/traces/${traceId}`;
}
export function recordedPhoenixLink(
  value: unknown,
  options: PhoenixTracingOptions,
) {
  const link =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  if (!options.enabled || link.enabled !== true)
    return { available: false, reason: "not_sampled", url: null };
  const url = phoenixTraceUrl(options, link.traceId);
  if (
    !url ||
    link.url !== url ||
    link.project !== (options.project ?? "generic-agents")
  )
    return { available: false, reason: "project_unavailable", url: null };
  return { available: true, reason: null, url };
}
