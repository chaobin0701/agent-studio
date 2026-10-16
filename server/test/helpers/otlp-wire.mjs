import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const rootDir = fileURLToPath(new URL("../fixtures/otlp/", import.meta.url));
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => join(rootDir, target);
root.loadSync("opentelemetry/proto/collector/trace/v1/trace_service.proto");
const request = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
export function decodePhoenixRequest(bytes) {
  const body = request.toObject(request.decode(Buffer.from(bytes)), {
    longs: String,
    bytes: Buffer,
  });
  for (const resource of body.resourceSpans ?? [])
    for (const scope of resource.scopeSpans ?? [])
      for (const span of scope.spans ?? []) {
        span.traceId = span.traceId.toString("hex");
        span.spanId = span.spanId.toString("hex");
        if (span.parentSpanId)
          span.parentSpanId = span.parentSpanId.toString("hex");
      }
  return body;
}
export const emptyOtlpResponse = () =>
  new Response(new Uint8Array(0), {
    headers: { "Content-Type": "application/x-protobuf" },
  });
