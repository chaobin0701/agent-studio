import { decodePhoenixRequest, emptyOtlpResponse } from "./otlp-wire.mjs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { localPhoenixUrl } from "../../dist/config/tracing-config.js";
// Hold the native transport before retrieval tests stub model/embedding fetch.
const nativeFetch = globalThis.fetch;
// Capture standard OTLP/HTTP from the real provider; optionally also deliver it
// to an explicitly selected local collector for opt-in persisted-span acceptance.
export const collectPhoenixSpans = (destination) => async (_url, options) => {
  const body = decodePhoenixRequest(options.body);
  const submitted = [];
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
        submitted.push({
          traceId: span.traceId,
          spanId: span.spanId,
          name: span.name,
          project: resource.resource.attributes.find(
            (a) => a.key === "openinference.project.name",
          ).value.stringValue,
        });
      }
  const endpoint = process.env.PHOENIX_ACCEPTANCE_ENDPOINT;
  if (!endpoint) return emptyOtlpResponse();
  if (!localPhoenixUrl(endpoint))
    throw new Error("Acceptance collector must be local");
  const response = await nativeFetch(endpoint, {
    ...options,
    signal: AbortSignal.timeout(3000),
    headers: {
      ...options.headers,
      ...(process.env.PHOENIX_API_KEY
        ? { Authorization: `Bearer ${process.env.PHOENIX_API_KEY}` }
        : {}),
    },
  });
  if (!response.ok) throw new Error("Local Phoenix rejected spans");
  if (process.env.PHOENIX_ACCEPTANCE_OUTPUT_DIR)
    appendFileSync(
      join(
        process.env.PHOENIX_ACCEPTANCE_OUTPUT_DIR,
        `spans-${process.pid}.jsonl`,
      ),
      submitted.map((x) => JSON.stringify(x) + "\n").join(""),
      { mode: 0o600 },
    );
  return response;
};
