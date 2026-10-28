import type {
  SpanProcessor,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { trace, type Context, type Span } from "@opentelemetry/api";
import { langSmithRunId } from "./trace-mapping";
import type { ResolvedTracingOptions } from "../config/tracing-config";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";

/** Private OTLP/HTTP processor: bounded memory, no retries, no ambient OTEL
 * headers/URLs, no redirects. Export never waits on the business request path. */
export class LangSmithSpanProcessor implements SpanProcessor {
  private readonly queue: ReadableSpan[] = [];
  private readonly active = new Map<string, Record<string, string>>();
  private draining?: Promise<void>;
  private closing = false;
  private inFlight = 0;
  readonly metrics = { exported: 0, failed: 0, dropped: 0 };
  constructor(
    private readonly options: ResolvedTracingOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  onStart(span: Span, parent: Context): void {
    const ids = span.spanContext(),
      runId = langSmithRunId(ids.traceId, ids.spanId);
    const parentContext = trace.getSpanContext(parent);
    const parentSpan = trace.getSpan(parent) as
      | (Span & { attributes?: Record<string, unknown> })
      | undefined;
    // Background work may inherit an already-ended business parent. Its span
    // still carries safe identity attributes; framework parents use SpanContext.
    const attrs =
      parentContext?.traceId === ids.traceId
        ? (this.active.get(parentContext.spanId) ??
          parentSpan?.attributes ??
          {})
        : {};
    const parentRun = attrs["langsmith.span.id"],
      root = attrs["langsmith.trace.id"],
      parentOrder = attrs["langsmith.span.dotted_order"];
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/gu, "")
      .replace(".", "")
      .replace("Z", "000Z");
    const mapping = {
      "langsmith.span.id": runId,
      "langsmith.trace.id": typeof root === "string" ? root : runId,
      "langsmith.span.dotted_order":
        (typeof parentOrder === "string" ? parentOrder + "." : "") +
        stamp +
        runId,
      ...(typeof parentRun === "string"
        ? { "langsmith.span.parent_id": parentRun }
        : {}),
    };
    span.setAttributes(mapping);
    this.active.set(ids.spanId, mapping);
  }
  rootRunId(spanId: string): string | undefined {
    return this.active.get(spanId)?.["langsmith.trace.id"];
  }
  onEnd(span: ReadableSpan): void {
    this.active.delete(span.spanContext().spanId);
    if (
      this.closing ||
      this.queue.length + this.inFlight >= this.options.queueLimit
    ) {
      this.metrics.dropped++;
      return;
    }
    this.queue.push(span);
    this.startDrain();
  }
  private startDrain(): void {
    if (this.draining || !this.queue.length) return;
    this.draining = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.draining = undefined;
        this.startDrain();
      });
  }
  private async drain(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, 64);
      this.inFlight = batch.length;
      try {
        const bytes = ProtobufTraceSerializer.serializeRequest(batch);
        const response = await this.fetcher(this.options.collectorEndpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(this.options.timeoutMs),
          headers: {
            "Content-Type": "application/x-protobuf",
            "x-api-key": this.options.apiKey,
            ...(this.options.workspaceId
              ? { "x-tenant-id": this.options.workspaceId }
              : {}),
            ...(this.options.agentIdentifier
              ? {
                  "Langsmith-Agent-Id": this.options.agentIdentifier,
                  "Langsmith-Agent-Environment": this.options.environment!,
                }
              : { "Langsmith-Project": this.options.project! }),
          },
          body: bytes ? Buffer.from(bytes) : undefined,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("export_failed");
        }
        const payload = new Uint8Array(await response.arrayBuffer());
        const result = (
          payload.length
            ? response.headers.get("content-type")?.includes("json")
              ? JSON.parse(new TextDecoder().decode(payload))
              : ProtobufTraceSerializer.deserializeResponse(payload)
            : {}
        ) as {
          partialSuccess?: { rejectedSpans?: string | number };
        };
        const rejected = Math.min(
          batch.length,
          Math.max(0, Number(result.partialSuccess?.rejectedSpans) || 0),
        );
        this.metrics.failed += rejected;
        this.metrics.exported += batch.length - rejected;
      } catch {
        this.metrics.failed += batch.length;
      } finally {
        // Never log raw bodies/secrets/stacks.
        this.inFlight = 0;
      }
    }
  }
  async flush(timeoutMs = 3000): Promise<boolean> {
    if (!this.draining) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          while (this.draining) await this.draining;
          return true;
        })(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async forceFlush(): Promise<void> {
    await this.flush();
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    this.active.clear();
    await this.flush();
    this.metrics.dropped += this.queue.length;
    this.queue.length = 0;
  }
}
