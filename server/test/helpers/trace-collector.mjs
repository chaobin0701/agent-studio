import { decodeOtlpRequest, emptyOtlpResponse } from "./otlp-wire.mjs";
import { LangSmithExecutionTracer } from "../../dist/observability/execution-tracer.js";
/** Explicit test-only credentials and destination; production has no defaults. */
export class TestExecutionTracer extends LangSmithExecutionTracer {
  constructor(options, fetcher) {
    super(
      {
        apiKey: "fixture-key",
        project: "fixture",
        ...options,
        ...(options.endpoint ? { webUrl: options.endpoint } : {}),
      },
      fetcher,
    );
  }
}
export const collectOtlpSpans = (destination) => async (_url, options) => {
  const body = decodeOtlpRequest(options.body);
  for (const resource of body.resourceSpans)
    for (const scope of resource.scopeSpans)
      for (const span of scope.spans) {
        const attributes = Object.fromEntries(
          span.attributes.map((a) => [a.key, Object.values(a.value)[0]]),
        );
        destination.push({
          ...span,
          attributes,
          metadata: JSON.parse(attributes.metadata),
        });
      }
  return emptyOtlpResponse();
};
