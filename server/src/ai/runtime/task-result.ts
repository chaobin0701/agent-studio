import type { AgentFinalOutput, AgentUsage } from "../agent/execution-contract";
import type { ContextResource } from "../context/context-contribution";
import type { SearchHit } from "../../documents/fuse-search-results";
import type { PendingFileOutput } from "../../artifacts/file-output";
import type { ToolExecutionTrace } from "../tools/tool-execution";

/** The sole native task result. Chat transcripts, cards and transport envelopes
 * are edge projections, not required fields or rules of the execution kernel.
 * Host diagnostics are private; public callers receive output and ledger usage. */
export type TaskExecutionResult = AgentUsage & {
  output: AgentFinalOutput;
  contextSnapshot: Record<string, unknown>;
  rawModelOutput: string | null;
  extensionResources?: readonly ContextResource[];
  fileOutputs?: readonly PendingFileOutput[];
  toolCalls: ToolExecutionTrace[];
  toolResults: Array<Record<string, unknown>>;
  sources: SearchHit[];
};
