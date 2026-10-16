import { z } from "zod";
import {
  assertSerializable,
  type AgentArtifact,
  type AgentReference,
  type JsonValue,
} from "../agent/execution-contract";
import type { ToolResult } from "../tools/tool-result";
import { redactToolData } from "../../tool-management/network";
import { FILE_ARTIFACT_KIND } from "../../artifacts/file-output";

const artifactSchema = z
  .object({
    kind: z.string().min(1).max(80),
    id: z.string().min(1).max(200).optional(),
    data: z.json(),
  })
  .strict();
const referenceSchema = z
  .object({
    kind: z.string().min(1).max(80),
    id: z.string().min(1).max(200),
    title: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export type CapabilityOutputs = {
  artifacts: AgentArtifact[];
  references: AgentReference[];
};

/** One resource may be returned by several authorized capabilities or members.
 * Identity is kind + id; retain the first validated metadata, not duplicates. */
export function uniqueCapabilityReferences(
  references: readonly AgentReference[],
): AgentReference[] {
  const selected = new Map<string, AgentReference>();
  for (const reference of references) {
    const key = JSON.stringify([reference.kind, reference.id]);
    if (!selected.has(key)) selected.set(key, reference);
  }
  return [...selected.values()];
}

/** Explicit capability outputs only, not arbitrary Tool.data. Bounded, JSON-only,
 * credential-redacted. Bad projections must not replay a successful operation. */
export function capabilityOutputs(
  result: ToolResult,
  callId: string,
  maxChars: number,
): CapabilityOutputs {
  const output: CapabilityOutputs = { artifacts: [], references: [] };
  if (!result.success) return output;
  let remaining = Math.min(50000, Math.max(0, maxChars));
  const push = (value: unknown, target: unknown[]) => {
    const cleaned = redactToolData(value);
    const encoded = JSON.stringify(cleaned);
    if (encoded && encoded.length <= remaining) {
      remaining -= encoded.length;
      target.push(cleaned);
    }
  };
  for (const [index, raw] of (Array.isArray(result.artifacts)
    ? result.artifacts
    : []
  )
    .slice(0, 20)
    .entries()) {
    try {
      assertSerializable(raw);
      if (JSON.stringify(raw).length > remaining) continue;
      const parsed = artifactSchema.safeParse(raw);
      if (parsed.success && parsed.data.kind !== FILE_ARTIFACT_KIND)
        push(
          { ...parsed.data, id: parsed.data.id ?? `${callId}:${index}` },
          output.artifacts,
        );
    } catch {
      /* Projection cannot affect a completed capability. */
    }
  }
  for (const raw of (Array.isArray(result.references)
    ? result.references
    : []
  ).slice(0, 20)) {
    try {
      assertSerializable(raw);
      if (JSON.stringify(raw).length > remaining) continue;
      const parsed = referenceSchema.safeParse(raw);
      if (
        parsed.success &&
        !output.references.some(
          (reference) =>
            reference.kind === parsed.data.kind &&
            reference.id === parsed.data.id,
        )
      )
        push(parsed.data, output.references);
    } catch {
      /* Invalid reference is not a failed operation. */
    }
  }
  return output;
}

export function selectCapabilityOutputs(
  final: {
    status: string;
    artifactIds?: string[];
    referenceIds?: string[];
    structured?: JsonValue;
  },
  available: Partial<CapabilityOutputs>,
) {
  if (final.status !== "answered") return {};
  const artifacts = (available.artifacts ?? []).filter(
    (a) => a.id && final.artifactIds?.includes(a.id),
  );
  const references = uniqueCapabilityReferences(
    available.references ?? [],
  ).filter((r) => final.referenceIds?.includes(r.id));
  return {
    ...(final.structured !== undefined
      ? { structured: redactToolData(final.structured) as JsonValue }
      : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(references.length ? { references } : {}),
  };
}
