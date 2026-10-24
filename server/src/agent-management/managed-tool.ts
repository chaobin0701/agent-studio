import { makeUiTool } from "../tool-management/ui-tool";
import { z } from "zod";
import { toolArgumentsHash } from "../ai/tools/tool-context";
import type { AgentTool } from "../ai/tools/agent-tool";
import type { ToolSpec, ResourceVersion } from "./resource.types";
import {
  executeHttp,
  type HttpDependencies,
} from "../tool-management/http-tool";

export function makeManagedTool(
  v: ResourceVersion,
  lookup: (key: string) => AgentTool,
  deps: HttpDependencies = {},
): AgentTool {
  const spec = v.config as ToolSpec;
  const base = spec.type === "ui" ? makeUiTool(spec.uiCatalog) : spec.type === "rest" ? undefined : lookup(spec.target!);
  const schema = spec.type === "ui" ? base!.inputSchema : z.fromJSONSchema(spec.parameters as any);
  return {
    execution: {
      ...base?.execution,
      channel: "tools",
      source:
        spec.type === "rest" ? "http" : spec.type === "mcp" ? "mcp" : "builtin",
      toolVersionId: v.id,
      requiresApproval: spec.requiresApproval,
    },
    runtimeLimits: { maxRetries: spec.maxRetries, timeoutMs: spec.timeoutMs },
    name: v.key,
    description: spec.type === "ui" ? `${spec.description}\n${base!.description}` : spec.description,
    inputSchema: base && spec.type !== "ui" ? z.intersection(base.inputSchema, schema) : schema,
    parameters: spec.parameters,
    inputDiagnostics: base?.inputDiagnostics,
    capabilities: base?.capabilities,
    contributeContext: base?.contributeContext,
    resultCacheKey:
      spec.readOnly && !spec.requiresApproval
        ? base?.resultCacheKey
        : undefined,
    planning: {
      canBatch: base?.planning?.canBatch ?? spec.readOnly,
      dependency: base?.planning?.dependency,
      isIdempotent: base
        ? (base.planning?.isIdempotent ?? spec.readOnly)
        : spec.readOnly || !!spec.idempotencyHeader,
    },
    async execute(input: any, context) {
      const approvedCall = context.toolApproval &&
        context.toolApproval.toolCallId &&
        context.toolApproval.toolVersionId === v.id &&
        context.toolApproval.argumentsHash === toolArgumentsHash(input);
      if (spec.requiresApproval && !approvedCall && !context.approvedTools?.includes(v.key))
        return {
          success: false,
          content: "该工具需要人工批准",
          errorCode: "tool_approval_required",
        };
      if (base) return base.execute(input, context);
      return executeHttp(v, input, context, deps);
    },
  };
}
