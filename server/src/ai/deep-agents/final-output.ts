import { z } from "zod";
import type {
  AgentFinalOutput,
  AgentReference,
} from "../agent/execution-contract";
import {
  selectCapabilityOutputs,
  uniqueCapabilityReferences,
} from "../runtime/capability-output";
import { redactToolData } from "../../tool-management/network";
import { AgentProtocolError } from "../agent/model-response";

const envelope = z.object({
  answer: z.string().trim().min(1).max(128000),
  status: z.enum(["answered", "completed", "refused"]).optional(),
  structured: z.json().optional(),
  referenceIds: z.array(z.string()).max(50).optional(),
  artifactIds: z.array(z.string()).max(50).optional(),
  citationIds: z.array(z.number().int().positive()).max(50).optional(),
  filePaths: z.array(z.string().min(1).max(240)).max(5).optional(),
});

export function finalFilePaths(text: string): string[] {
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, "$1")
    .trim();
  if (!candidate.startsWith("{")) return [];
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!json || typeof json !== "object" || !("answer" in json)) return [];
  const parsed = envelope.safeParse(json);
  if (!parsed.success) throw new TypeError("Invalid structured final answer");
  return parsed.data.filePaths ?? [];
}

/** Plain native answers are first-class. A requested structured envelope is
 * optional, validated without another model call, and cannot fabricate assets. */
export function finalOutput(
  text: string,
  available: Pick<AgentFinalOutput, "artifacts" | "references">,
  usage: AgentFinalOutput["usage"],
): AgentFinalOutput {
  let parsed: z.infer<typeof envelope> | undefined;
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, "$1")
    .trim();
  if (candidate.startsWith("{")) {
    try {
      const json: unknown = JSON.parse(candidate);
      if (json && typeof json === "object" && "answer" in json)
        parsed = envelope.parse(json);
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new AgentProtocolError("invalid_final_answer");
      // Native prose is supported, but a recognizable broken final envelope is
      // not a successful answer. Do not expose its wire keys or repair it by
      // making another paid model call.
      if (/"answer"\s*:/u.test(candidate))
        throw new AgentProtocolError("invalid_final_answer");
    }
  }
  if (!parsed)
    return {
      status: "completed",
      answer: text,
      artifacts: available.artifacts.slice(0, 50),
      references: uniqueCapabilityReferences(available.references).slice(0, 50),
      usage,
    };
  const status = parsed.status === "refused" ? "refused" : "completed";
  const referenceIds = parsed.referenceIds ?? parsed.citationIds?.map(String);
  const selected = selectCapabilityOutputs(
    {
      ...parsed,
      status: status === "completed" ? "answered" : "refused",
      referenceIds: referenceIds ?? available.references.map((ref) => ref.id),
      artifactIds:
        parsed.artifactIds ??
        available.artifacts.flatMap((artifact) =>
          artifact.id ? [artifact.id] : [],
        ),
    },
    available,
  );
  return {
    status,
    answer: parsed.answer,
    ...selected,
    artifacts: selected.artifacts ?? [],
    references: selected.references ?? [],
    usage,
  };
}

export type MountedDocument = { reference: AgentReference; content: string };
export function documentMounts(documents: readonly MountedDocument[]) {
  if (documents.length > 5) throw new RangeError("Too many mounted documents");
  const paths = new Map<string, MountedDocument>();
  for (const document of documents) {
    if (
      document.reference.kind !== "document" ||
      !/^[1-9][0-9]{0,14}$/u.test(document.reference.id) ||
      document.content.length > 50000
    )
      throw new TypeError("Invalid trusted document mount");
    paths.set(`/documents/${document.reference.id}.md`, {
      ...document,
      content: redactToolData(document.content) as string,
    });
  }
  return paths;
}
