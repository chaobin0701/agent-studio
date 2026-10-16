import { z } from "zod";
import { AgentTool } from "./agent-tool";
import { ToolResult } from "./tool-result";
import { Injectable, Optional } from "@nestjs/common";
import { AppConfigService } from "../../config/config.service";

export const DEFAULT_MAX_TOOL_CALLS = 6;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESULT_CHARS = 12_000;

export type ToolExecutionState = {
  callCount: number;
  seenCalls: Set<string>;
  allowedTools?: ReadonlySet<string>;
  maxToolCalls?: number;
  timeoutMs?: number;
  maxResultChars?: number;
  resultCache?: Map<string, ToolResult>;
};

export type ToolPolicyFailure =
  | "tool_call_limit_exceeded"
  | "duplicate_tool_call"
  | "invalid_arguments"
  | "tool_not_allowed";

export type ToolInputValidation =
  | { ok: true; input: unknown }
  | { ok: false; errorCode: ToolPolicyFailure };

@Injectable()
export class ToolPolicy {
  constructor(@Optional() private readonly config?: AppConfigService) {}

  get maxToolCalls() {
    return this.config?.agent.runtime.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  }
  get timeoutMs() {
    return this.config?.agent.runtime.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }
  get maxResultChars() {
    return (
      this.config?.agent.runtime.maxToolResultChars ?? DEFAULT_MAX_RESULT_CHARS
    );
  }

  createState(
    options: {
      allowedTools?: readonly string[];
      maxToolCalls?: number;
      timeoutMs?: number;
      maxResultChars?: number;
    } = {},
  ): ToolExecutionState {
    return {
      callCount: 0,
      seenCalls: new Set<string>(),
      allowedTools: options.allowedTools
        ? new Set(options.allowedTools)
        : undefined,
      maxToolCalls: options.maxToolCalls,
      timeoutMs: options.timeoutMs,
      maxResultChars: options.maxResultChars,
    };
  }

  beforeCall(
    state: ToolExecutionState,
    name: string,
    args: Record<string, unknown>,
  ): ToolPolicyFailure | null {
    const failure = this.checkCall(state, name, args);
    if (failure) return failure;
    state.seenCalls.add(JSON.stringify({ name, arguments: args }));
    state.callCount += 1;
    return null;
  }

  /** Inspect a deferred request without charging or marking an unexecuted call as seen. */
  checkCall(
    state: ToolExecutionState,
    name: string,
    args: Record<string, unknown>,
  ): ToolPolicyFailure | null {
    if (state.allowedTools && !state.allowedTools.has(name))
      return "tool_not_allowed";
    if (state.callCount >= (state.maxToolCalls ?? this.maxToolCalls))
      return "tool_call_limit_exceeded";
    const key = JSON.stringify({ name, arguments: args });
    if (state.seenCalls.has(key)) return "duplicate_tool_call";
    return null;
  }

  validateInput(
    tool: AgentTool,
    args: Record<string, unknown>,
  ): ToolInputValidation {
    const parsed = tool.inputSchema.safeParse(args);
    return parsed.success
      ? { ok: true, input: parsed.data }
      : { ok: false, errorCode: "invalid_arguments" };
  }

  normalizeResult(
    result: ToolResult,
    maxChars = this.maxResultChars,
  ): ToolResult {
    if (result.content.length <= maxChars) return result;
    return {
      ...result,
      content: `${result.content.slice(0, maxChars)}\n[tool_result_truncated]`,
      metadata: { ...result.metadata, resultTruncated: true },
    };
  }
}
