import type {
  SpanProcessor,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { ProtobufTraceSerializer } from "@opentelemetry/otlp-transformer";

/** Private OTLP/HTTP processor: bounded memory, no retries, no ambient OTEL
 * headers/URLs, no redirects. Export never waits on the business request path. */
export class PhoenixSpanProcessor implements SpanProcessor {
  private readonly queue: ReadableSpan[] = [];
  private draining?: Promise<void>;
  private closing = false;
  private inFlight = 0;
  readonly metrics = { exported: 0, failed: 0, dropped: 0 };
  constructor(
    private readonly options: {
      endpoint: string;
      apiKey?: string;
      timeoutMs: number;
      queueLimit: number;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
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
        const response = await this.fetcher(this.options.endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(this.options.timeoutMs),
          headers: {
            "Content-Type": "application/x-protobuf",
            ...(this.options.apiKey
              ? { Authorization: `Bearer ${this.options.apiKey}` }
              : {}),
          },
          body: bytes ? Buffer.from(bytes) : undefined,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("export_failed");
        }
        const result = ProtobufTraceSerializer.deserializeResponse(
          new Uint8Array(await response.arrayBuffer()),
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
    await this.flush();
    this.metrics.dropped += this.queue.length;
    this.queue.length = 0;
  }
}
