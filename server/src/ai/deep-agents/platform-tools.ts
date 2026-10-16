import { DynamicStructuredTool } from "@langchain/core/tools";
import { createHash } from "node:crypto";
import type { AgentTool } from "../tools/agent-tool";
import {
  ToolExecutionService,
  type ToolExecutionOutcome,
} from "../tools/tool-execution";
import type { ToolContext } from "../tools/tool-context";
import type { ToolExecutionState } from "../tools/tool-policy";
import type { RetryStatusEvent } from "../../chat/llm.service";
import type { AgentFinalOutput } from "../agent/execution-contract";

const reserved = new Set([
  "task",
  "agent_result",
  "write_todos",
  "execute",
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "delete",
]);

/** Preserve resource keys; only framework collisions/oversized provider names
 * receive deterministic model-visible aliases. No new capability is granted. */
export function platformToolMap(
  tools: readonly AgentTool[],
): Map<string, AgentTool> {
  const originalNames = new Set(tools.map((tool) => tool.name));
  if (originalNames.size !== tools.length)
    throw new TypeError("Duplicate platform tool key");
  const map = new Map<string, AgentTool>();
  for (const tool of tools) {
    let name = tool.name;
    if (reserved.has(name) || name.length > 64) {
      let salt = 0;
      do {
        name = `platform_${tool.name.slice(0, 32)}_${createHash("sha256").update(`${tool.name}:${salt++}`).digest("hex").slice(0, 12)}`;
      } while (originalNames.has(name) || map.has(name));
    }
    map.set(name, tool);
  }
  return map;
}

/** Platform authorization and freshness are checked by the existing gateway.
 * StructuredTool supplies model schema/call parity, never a bypass to execute(). */
export function platformTools(
  tools: readonly AgentTool[],
  gateway: ToolExecutionService,
  context: ToolContext,
  state: ToolExecutionState,
  onOutcome: (
    name: string,
    outcome: ToolExecutionOutcome,
  ) => void | Pick<AgentFinalOutput, "artifacts" | "references">,
  onRetryStatus?: (event: RetryStatusEvent) => void,
  exposed: ReadonlyMap<string, AgentTool> = platformToolMap(tools),
) {
  return [...exposed].map(([name, tool]) => {
    if (!state.allowedTools?.has(tool.name))
      throw new TypeError("Invalid authorized platform tool set");
    return new DynamicStructuredTool({
      name,
      description:
        name === tool.name
          ? tool.description
          : `平台 Tool Key：${tool.name}；调用名称：${name}。${tool.description}`,
      // LangChain's JSON-schema dereferencer adds internal properties. Never
      // let it mutate the immutable published/request configuration snapshot.
      schema: tool.parameters
        ? structuredClone(tool.parameters)
        : tool.inputSchema,
      func: async (args, _manager, config) => {
        const signal =
          context.signal && config?.signal
            ? AbortSignal.any([context.signal, config.signal])
            : (context.signal ?? config?.signal);
        const outcome = await gateway.execute(
          tool.name,
          args as Record<string, unknown>,
          { ...context, signal },
          state,
          { onRetryStatus },
        );
        // Optional projection cannot turn a completed write into a retry.
        let projected: void | Pick<
          AgentFinalOutput,
          "artifacts" | "references"
        > = undefined;
        try {
          projected = onOutcome(tool.name, outcome);
        } catch {
          /* Diagnostics only. */
        }
        return JSON.stringify({
          success: outcome.result.success,
          content: outcome.result.content,
          ...(projected?.artifacts.length
            ? { artifacts: projected.artifacts }
            : {}),
          ...(projected?.references.length
            ? { references: projected.references }
            : {}),
          ...(outcome.result.errorCode
            ? { errorCode: outcome.result.errorCode }
            : {}),
        });
      },
    });
  });
}
