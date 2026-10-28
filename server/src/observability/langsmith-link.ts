import { Injectable } from "@nestjs/common";
import { AppConfigService } from "../config/config.service";
import {
  normalizeTracingOptions,
  type TracingOptions,
} from "../config/tracing-config";
import {
  configuredTraceUrl,
  destinationId,
  safeExternalTrace,
  safeLangSmithAppPath,
} from "./trace-mapping";
export type ExternalTraceLink = {
  available: boolean;
  reason: string | null;
  url: string | null;
  provider: "langsmith";
  ingestion: "unverified" | "confirmed";
};
/** Read on demand, outside execution paths. Never persists trace bodies. */
export async function recordedLangSmithLink(
  value: unknown,
  options: TracingOptions,
  fetcher: typeof fetch = fetch,
): Promise<ExternalTraceLink> {
  const o = normalizeTracingOptions(options),
    mapping = safeExternalTrace(value);
  const unavailable = (reason: string): ExternalTraceLink => ({
    available: false,
    reason,
    url: null,
    provider: "langsmith",
    ingestion: "unverified",
  });
  if (!o.enabled) return unavailable("disabled");
  if (!mapping) return unavailable("historical_or_missing");
  if (!mapping.enabled) return unavailable("not_sampled");
  if (mapping.destination !== destinationId(o))
    return unavailable("destination_changed");
  const configured = configuredTraceUrl(o, mapping.runId);
  if (configured)
    return {
      available: true,
      reason: null,
      url: configured,
      provider: "langsmith",
      ingestion: "unverified",
    };
  try {
    const response = await fetcher(o.endpoint + "/runs/" + mapping.runId, {
      method: "GET",
      redirect: "error",
      // Link lookup is an admin action, separate from the short export budget.
      signal: AbortSignal.timeout(10000),
      headers: {
        "x-api-key": o.apiKey,
        ...(o.workspaceId ? { "x-tenant-id": o.workspaceId } : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(
        response.status === 401
          ? "invalid_credentials"
          : response.status === 429
            ? "rate_limited"
            : response.status === 403
              ? "read_permission_required"
              : response.status === 404
                ? "not_ingested"
                : "lookup_failed",
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (body.id !== mapping.runId) return unavailable("lookup_failed");
    const url = safeLangSmithAppPath(o.webUrl, body.app_path, mapping.runId);
    return url
      ? {
          available: true,
          reason: null,
          url,
          provider: "langsmith",
          ingestion: "confirmed",
        }
      : unavailable("link_unavailable");
  } catch (error) {
    return unavailable(
      error instanceof Error && error.name === "TimeoutError"
        ? "lookup_timeout"
        : "lookup_failed",
    );
  }
}
@Injectable()
export class LangSmithLinkService {
  private readonly cache = new Map<
    string,
    { until: number; result: Promise<ExternalTraceLink> }
  >();
  constructor(private readonly config: AppConfigService) {}
  resolve(value: unknown): Promise<ExternalTraceLink> {
    const key = JSON.stringify(safeExternalTrace(value) ?? null),
      cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.result;
    const entry: { until: number; result: Promise<ExternalTraceLink> } = {
      until: Number.POSITIVE_INFINITY,
      result: recordedLangSmithLink(value, this.config.tracing).then((link) => {
        // Keep successful links through transient cloud failures. Failed
        // lookups expire quickly so a manual refresh can recover.
        entry.until = Date.now() + (link.available ? 300000 : 2000);
        return link;
      }),
    };
    if (this.cache.size >= 500)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, entry);
    return entry.result;
  }
}
