import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { CompiledStateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { AgentTool } from "../tools/agent-tool";
import type { ToolResult } from "../tools/tool-result";
import {
  assertSerializable,
  type JsonObject,
  type JsonValue,
} from "../agent/execution-contract";
import {
  currentExecutionBudget,
  SharedExecutionBudget,
  withExecutionBudget,
} from "../agent/execution-budget";
import { privateFrameworkCallbackHandlers } from "../agent/private-framework-callbacks";
import { frameworkTracing } from "../../observability/execution-tracer";
import { frameworkModelCallbacks } from "../../observability/framework-callbacks";
import { PlatformChatModel } from "../deep-agents/platform-chat-model";
import {
  currentWorkflowHost,
  withWorkflowHost,
  type WorkflowRecord,
} from "./workflow-host";
import {
  executionSpan,
  annotateExecution,
} from "../../observability/execution-tracer";
import { redactToolData } from "../../tool-management/network";

export const SPECIALIZED_WORKFLOW_RUNTIME = "langgraph-1.5.0/specialized-v1";
const MAX_JSON_BYTES = 128 * 1024;
const activeFlow = new AsyncLocalStorage<boolean>();
const key = /^[a-z][a-z0-9_]{0,79}$/u;
const version = /^[1-9][0-9]{0,5}(?:\.[0-9]{1,6}){0,2}$/u;

type WorkflowCode =
  | "workflow_context_required"
  | "workflow_not_allowed"
  | "workflow_dependency_missing"
  | "workflow_nesting_denied"
  | "workflow_invalid_input"
  | "workflow_invalid_output"
  | "workflow_limit_exceeded"
  | "workflow_timeout"
  | "workflow_tool_failed"
  | "workflow_model_failed"
  | "workflow_failed";
export class WorkflowExecutionError extends Error {
  constructor(readonly code: WorkflowCode) {
    super("Specialized workflow execution failed");
    this.name = "WorkflowExecutionError";
  }
}

/** Effects, not service handles. No free-form tool/model permissions, delegation,
 * raw streaming, host filesystem or resumable side-effect promises. */
export type WorkflowEffects = {
  signal: AbortSignal;
  node<T>(name: string, operation: () => Promise<T>): Promise<T>;
  tool(name: string, input: JsonObject): Promise<ToolResult>;
  model(instructions: string, input: string): Promise<string>;
};
/** Trusted code registration only. The graph factory returns an actual compiled
 * StateGraph. LangGraph owns routing; the platform owns the effect boundary. */
export type SpecializedWorkflow = {
  key: string;
  version: string;
  description: string;
  inputSchema: z.ZodType<JsonObject>;
  outputSchema: z.ZodType<JsonValue>;
  allowedTools: readonly string[];
  limits: {
    maxSteps: number;
    maxModelCalls: number;
    maxToolCalls: number;
    maxDurationMs: number;
  };
  build(
    effects: WorkflowEffects,
  ): CompiledStateGraph<any, any, any, any, any, any>;
};

function bounded(value: unknown, code: WorkflowCode): JsonValue {
  try {
    assertSerializable(value);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_BYTES)
      throw new RangeError();
    return structuredClone(value);
  } catch {
    throw new WorkflowExecutionError(code);
  }
}
function errorCode(error: unknown): WorkflowCode {
  return error instanceof WorkflowExecutionError
    ? error.code
    : "workflow_failed";
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
  ]).finally(() => signal.removeEventListener("abort", abort!));
}

async function execute(
  definition: SpecializedWorkflow,
  input: unknown,
  toolSignal?: AbortSignal,
): Promise<JsonValue> {
  const host = currentWorkflowHost();
  if (!host || !currentExecutionBudget())
    throw new WorkflowExecutionError("workflow_context_required");
  if (activeFlow.getStore())
    throw new WorkflowExecutionError("workflow_nesting_denied");
  const granted = host.tools.some(
    (tool) =>
      tool.execution?.workflow?.key === definition.key &&
      tool.execution.workflow.version === definition.version &&
      host.toolState.allowedTools?.has(tool.name) &&
      host.toolContext.permissions.includes(tool.name),
  );
  if (!granted) throw new WorkflowExecutionError("workflow_not_allowed");
  const ownTools = new Map(host.tools.map((tool) => [tool.name, tool]));
  for (const name of definition.allowedTools) {
    const tool = ownTools.get(name);
    if (
      !tool ||
      !host.toolState.allowedTools?.has(name) ||
      !host.toolContext.permissions.includes(name) ||
      tool.execution?.workflow ||
      ["run_skill", "delegate_agent", "load_skill"].includes(name)
    )
      throw new WorkflowExecutionError("workflow_dependency_missing");
  }
  const raw = bounded(input, "workflow_invalid_input");
  const parsed = definition.inputSchema.safeParse(raw);
  if (!parsed.success)
    throw new WorkflowExecutionError("workflow_invalid_input");
  const initial = bounded(parsed.data, "workflow_invalid_input") as JsonObject;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    host.signal,
    controller.signal,
    ...(toolSignal ? [toolSignal] : []),
  ]);
  const record: WorkflowRecord = {
    key: definition.key,
    version: definition.version,
    ok: false,
    durationMs: 0,
    nodes: 0,
    modelCalls: 0,
    toolCalls: 0,
  };
  const started = Date.now();
  const check = () => signal.throwIfAborted();
  let serialTools = Promise.resolve();
  const effects: WorkflowEffects = Object.freeze({
    signal,
    async node<T>(name: string, operation: () => Promise<T>): Promise<T> {
      check();
      if (!key.test(name) || record.nodes >= definition.limits.maxSteps)
        throw new WorkflowExecutionError("workflow_limit_exceeded");
      record.nodes++;
      return executionSpan(
        "workflow_node",
        "chain",
        { node: name },
        async () => {
          const value = await abortable(operation(), signal);
          check();
          return bounded(value, "workflow_invalid_output") as T;
        },
      );
    },
    async tool(name: string, args: JsonObject): Promise<ToolResult> {
      check();
      if (!definition.allowedTools.includes(name))
        throw new WorkflowExecutionError("workflow_not_allowed");
      if (record.toolCalls >= definition.limits.maxToolCalls)
        throw new WorkflowExecutionError("workflow_limit_exceeded");
      record.toolCalls++;
      const validated = bounded(args, "workflow_invalid_input") as JsonObject;
      const previous = serialTools;
      let release!: () => void;
      serialTools = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await abortable(previous, signal);
        check();
        if (!host.gateway)
          throw new WorkflowExecutionError("workflow_context_required");
        const outcome = await host.gateway.execute(
          name,
          validated,
          { ...host.toolContext, signal, permissions: definition.allowedTools },
          host.toolState,
          { onRetryStatus: host.onRetryStatus },
        );
        host.onTool(name, `workflow-${randomUUID()}`, outcome);
        check();
        if (!outcome.result.success)
          throw new WorkflowExecutionError("workflow_tool_failed");
        // Never expose arbitrary adapter instances or unbounded data to graph state.
        return bounded(
          redactToolData(outcome.result),
          "workflow_invalid_output",
        ) as unknown as ToolResult;
      } finally {
        release();
      }
    },
    async model(instructions: string, text: string): Promise<string> {
      check();
      if (record.modelCalls >= definition.limits.maxModelCalls)
        throw new WorkflowExecutionError("workflow_limit_exceeded");
      record.modelCalls++;
      if (
        typeof instructions !== "string" ||
        typeof text !== "string" ||
        instructions.length > 24000 ||
        text.length > 50000
      )
        throw new WorkflowExecutionError("workflow_invalid_input");
      if (!host.llm)
        throw new WorkflowExecutionError("workflow_context_required");
      const model = new PlatformChatModel(
        host.llm,
        "planner",
        host.onRetryStatus,
        host.onModel,
        `${definition.key}/${definition.version}`,
        undefined,
        host.onModelFailure,
      );
      const response = await model.invoke(
        [
          new SystemMessage(
            `${host.systemPrompt}\n\n专项流程指导：\n${instructions}`,
          ),
          new HumanMessage(text),
        ],
        {
          signal,
          callbacks: frameworkModelCallbacks([
            ...privateFrameworkCallbackHandlers,
          ]),
        },
      );
      check();
      if (
        typeof response.content !== "string" ||
        response.tool_calls?.length ||
        response.response_metadata.finish_reason !== "stop"
      )
        throw new WorkflowExecutionError("workflow_model_failed");
      return response.content;
    },
  });
  const timer = setTimeout(
    () => controller.abort(new WorkflowExecutionError("workflow_timeout")),
    Math.min(
      definition.limits.maxDurationMs,
      host.toolState.timeoutMs ?? 30000,
    ),
  );
  timer.unref();
  try {
    return await activeFlow.run(true, () =>
      executionSpan(
        "specialized_workflow",
        "chain",
        {
          ...host.versions,
          graphVersion: SPECIALIZED_WORKFLOW_RUNTIME,
          workflowKey: definition.key,
          workflowVersion: definition.version,
        },
        async () => {
          try {
            check();
            const graph = definition.build(effects);
            if (!(graph instanceof CompiledStateGraph))
              throw new WorkflowExecutionError("workflow_invalid_output");
            if (
              graph.retryPolicy ||
              Object.values(graph.nodes).some(
                (node) => node.retryPolicy || node.cachePolicy,
              ) ||
              graph.checkpointer ||
              graph.store ||
              graph.cache ||
              graph.debug ||
              graph.config ||
              (graph.interruptBefore?.length ?? 0) ||
              (graph.interruptAfter?.length ?? 0)
            )
              throw new WorkflowExecutionError("workflow_invalid_output");
            const capture = frameworkTracing(Object.keys(graph.nodes));
            const config: RunnableConfig = {
              signal,
              callbacks: [
                ...privateFrameworkCallbackHandlers,
                ...capture.callbacks,
              ],
              recursionLimit: definition.limits.maxSteps + 1,
            };
            let rawResult: JsonValue;
            try {
              rawResult = bounded(
                await abortable(graph.invoke(initial, config), signal),
                "workflow_invalid_output",
              );
            } finally {
              capture.close();
            }
            check();
            const result = definition.outputSchema.safeParse(rawResult);
            if (!result.success)
              throw new WorkflowExecutionError("workflow_invalid_output");
            const final = bounded(
              redactToolData(result.data),
              "workflow_invalid_output",
            );
            if (!definition.outputSchema.safeParse(final).success)
              throw new WorkflowExecutionError("workflow_invalid_output");
            record.ok = true;
            return final;
          } catch (error) {
            record.errorCode = signal.aborted
              ? host.signal.aborted
                ? host.signal.reason?.code === "agent_timeout"
                  ? "agent_timeout"
                  : "run_cancelled"
                : "workflow_timeout"
              : errorCode(error);
            throw error;
          } finally {
            annotateExecution({
              workflowNodeCount: record.nodes,
              workflowModelCalls: record.modelCalls,
              workflowToolCalls: record.toolCalls,
              status: record.ok ? "completed" : "failed",
              errorCode: record.errorCode,
            });
          }
        },
      ),
    );
  } finally {
    clearTimeout(timer);
    controller.abort(new WorkflowExecutionError("workflow_failed"));
    record.durationMs = Date.now() - started;
    host.onWorkflow?.({ ...record });
  }
}

/** No outer retry: retrying a partially completed graph can replay writes. Each
 * actual tool/model attempt still belongs to its existing authoritative layer. */
function specializedWorkflowTool(definition: SpecializedWorkflow): AgentTool {
  const tool: AgentTool = Object.freeze({
    name: definition.key,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execution: {
      channel: "tools",
      source: "builtin",
      workflow: {
        key: definition.key,
        version: definition.version,
        requiredTools: [...definition.allowedTools],
        requiresAgentContext: definition.limits.maxModelCalls > 0 || definition.limits.maxToolCalls > 0 || definition.allowedTools.length > 0,
      },
    },
    runtimeLimits: {
      maxRetries: 0,
      timeoutMs: definition.limits.maxDurationMs,
    },
    planning: { canBatch: false, isIdempotent: false },
    async execute(
      input: unknown,
      context: import("../tools/tool-context").ToolContext,
    ): Promise<ToolResult> {
      try {
        // Existing Tool management can genuinely test the resource-free reference
        // graph before publication. This isolated zero-effect host has no model,
        // gateway, Prompt, published dependencies or cross-request storage.
        const pure =
          !currentWorkflowHost() &&
          definition.limits.maxModelCalls === 0 &&
          definition.limits.maxToolCalls === 0 &&
          !definition.allowedTools.length;
        const run = () => execute(definition, input, context.signal);
        const result = pure
          ? await withExecutionBudget(
              new SharedExecutionBudget({ maxModelCalls: 0, maxToolCalls: 0 }),
              () =>
                withWorkflowHost(
                  {
                    tools: [tool],
                    toolContext: context,
                    toolState: {
                      callCount: 0,
                      seenCalls: new Set(),
                      allowedTools: new Set([tool.name]),
                      maxToolCalls: 0,
                    },
                    signal: context.signal ?? new AbortController().signal,
                    versions: {},
                    systemPrompt: "",
                    onModel: () => {},
                    onModelFailure: () => {},
                    onTool: () => {},
                  },
                  run,
                ),
            )
          : await run();
        return { success: true, content: JSON.stringify(result), data: result };
      } catch (error) {
        if (context.signal?.aborted) throw context.signal.reason;
        return {
          success: false,
          content: "专项流程未完成；不自动重放，请检查执行记录。",
          errorCode: errorCode(error),
        };
      }
    },
  } satisfies AgentTool);
  return tool;
}

@Injectable()
export class SpecializedWorkflowRegistry {
  private readonly definitions = new Map<string, SpecializedWorkflow>();
  register(value: SpecializedWorkflow): void {
    if (
      !key.test(value.key) ||
      !version.test(value.version) ||
      !value.key.endsWith(`_v${value.version.replaceAll(".", "_")}`) ||
      !value.description.trim() ||
      value.description.length > 2000 ||
      this.definitions.has(value.key) ||
      value.allowedTools.length > 20 ||
      new Set(value.allowedTools).size !== value.allowedTools.length ||
      value.allowedTools.some(
        (name) =>
          !key.test(name) ||
          name === value.key ||
          ["run_skill", "delegate_agent", "load_skill"].includes(name),
      ) ||
      !Number.isInteger(value.limits.maxSteps) ||
      value.limits.maxSteps < 1 ||
      value.limits.maxSteps > 32 ||
      !Number.isInteger(value.limits.maxModelCalls) ||
      value.limits.maxModelCalls < 0 ||
      value.limits.maxModelCalls > 8 ||
      !Number.isInteger(value.limits.maxToolCalls) ||
      value.limits.maxToolCalls < 0 ||
      value.limits.maxToolCalls > 20 ||
      !Number.isInteger(value.limits.maxDurationMs) ||
      value.limits.maxDurationMs < 1 ||
      value.limits.maxDurationMs > 120000
    )
      throw new TypeError(
        "Invalid or duplicate specialized workflow registration",
      );
    this.definitions.set(
      value.key,
      Object.freeze({
        ...value,
        allowedTools: Object.freeze([...value.allowedTools]),
        limits: Object.freeze({ ...value.limits }),
      }),
    );
  }
  tools(): AgentTool[] {
    return [...this.definitions.values()].map(specializedWorkflowTool);
  }
}
