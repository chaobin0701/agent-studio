import {
  normalizeSchema,
  validateStructured,
  OutputContractError,
} from "@agent-studio/output-contract";
import type { JsonObject } from "../agent/execution-contract";

export function validatedOutputSchema(value: unknown): JsonObject {
  return normalizeSchema(value) as JsonObject;
}
export function assertStructuredResult(schema: unknown, value: unknown) {
  const issues = validateStructured(schema, value);
  if (issues.length)
    throw new OutputContractError(
      "output_validation_failed",
      issues.map((i) => ({ ...i, path: "$.structured" + i.path.slice(1) })),
    );
}
export function resultEnvelopeSchema(
  structured: unknown,
  allowFiles = false,
  title = "agent_result",
) {
  return {
    title,
    type: "object" as const,
    properties: {
      answer: { type: "string", minLength: 1, maxLength: 128000 },
      structured: validatedOutputSchema(structured),
      status: { type: "string", enum: ["completed", "refused"] },
      ...(allowFiles
        ? {
            filePaths: {
              type: "array",
              items: { type: "string", maxLength: 240 },
              maxItems: 5,
            },
            artifactIds: {
              type: "array",
              items: { type: "string", maxLength: 200 },
              maxItems: 50,
            },
          }
        : {}),
    },
    required: ["answer"],
    additionalProperties: false,
  };
}
