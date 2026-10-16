import { AsyncLocalStorage } from "node:async_hooks";
import type {
  LlmService,
  ModelResult,
  RetryStatusEvent,
} from "../../chat/llm.service";
import type { ModelFailureDiagnostic } from "../deep-agents/platform-chat-model";
import type {
  ToolExecutionService,
  ToolExecutionOutcome,
} from "../tools/tool-execution";
import type { ToolContext } from "../tools/tool-context";
import type { ToolExecutionState } from "../tools/tool-policy";
import type { AgentTool } from "../tools/agent-tool";
import type { JsonObject } from "../agent/execution-contract";

export type WorkflowRecord = {
  key: string;
  version: string;
  ok: boolean;
  durationMs: number;
  nodes: number;
  modelCalls: number;
  toolCalls: number;
  errorCode?: string;
};

/** Live native host only, never public request JSON, persisted graph state or a
 * registry-wide fallback. Members get their own host and already-pinned scope. */
export type WorkflowHost = {
  /** Absent only for a zero-effect pure-graph administrative Tool test. */
  llm?: LlmService;
  gateway?: ToolExecutionService;
  tools: readonly AgentTool[];
  toolContext: ToolContext;
  toolState: ToolExecutionState;
  signal: AbortSignal;
  versions: JsonObject;
  systemPrompt: string;
  onRetryStatus?: (event: RetryStatusEvent) => void;
  onModel: (result: ModelResult) => void;
  onModelFailure: (failure: ModelFailureDiagnostic) => void;
  onTool: (name: string, callId: string, outcome: ToolExecutionOutcome) => void;
  onWorkflow?: (record: WorkflowRecord) => void;
};
const nativeHost = new AsyncLocalStorage<{
  host: WorkflowHost;
  active: boolean;
}>();
export const currentWorkflowHost = () => {
  const scope = nativeHost.getStore();
  return scope?.active ? scope.host : undefined;
};
export function withWorkflowHost<T>(
  host: WorkflowHost,
  operation: () => Promise<T>,
): Promise<T> {
  const scope = { host, active: true };
  return nativeHost.run(scope, async () => {
    try {
      return await operation();
    } finally {
      scope.active = false;
    }
  });
}
