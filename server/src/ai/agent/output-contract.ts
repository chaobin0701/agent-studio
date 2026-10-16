import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import {
  resolveContract,
  normalizeContract,
  OutputContractError,
  type ContractIssue,
} from "@agent-studio/output-contract";
import type { AgentTaskInput, JsonObject } from "./execution-contract";

export { normalizeContract, OutputContractError };

/** One resolver for every entry. Schema content is data, never a capability. */
export function agentOutputContract(
  configured: unknown,
  versionId: number,
  requested?: unknown,
) {
  const resolved = resolveContract(configured, requested);
  return {
    ...resolved,
    schemaHash:
      resolved.mode === "json"
        ? createHash("sha256")
            .update(JSON.stringify(resolved.schema))
            .digest("hex")
        : null,
    agentVersionId: versionId,
  };
}
export function outputTask(
  configured: unknown,
  versionId: number,
  requested?: unknown,
): Pick<AgentTaskInput, "outputSchema" | "outputContract"> {
  const contract = agentOutputContract(configured, versionId, requested);
  return {
    ...(contract.mode === "json"
      ? { outputSchema: contract.schema as JsonObject }
      : {}),
    outputContract: {
      mode: contract.mode,
      source: contract.source,
      schemaHash: contract.schemaHash,
      agentVersionId: versionId,
    },
  };
}
/** Reject conflicts before quota reservation or model calls. */
export function preflightOutput(
  configured: unknown,
  versionId: number,
  requested?: unknown,
) {
  try {
    return agentOutputContract(configured, versionId, requested);
  } catch (error) {
    if (!(error instanceof OutputContractError)) throw error;
    throw new BadRequestException({
      code: error.code,
      message: error.message,
      issues: error.issues,
    });
  }
}
export function outputFailureIssues(
  error: unknown,
): ContractIssue[] | undefined {
  return error instanceof OutputContractError ? error.issues : undefined;
}
