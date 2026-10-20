import { AsyncLocalStorage } from "node:async_hooks";
import { AgentRunLimitError } from "./execution-contract";

export const DEFAULT_MAX_TASKS = 3;
export type ExecutionBudgetLimits = {
  maxModelCalls: number;
  maxToolCalls: number;
  maxTotalTokens?: number;
  enabled?: {
    maxModelCalls: boolean;
    maxToolCalls: boolean;
    maxTotalTokens: boolean;
  };
};
export const PLATFORM_EXECUTION_LIMITS = {
  maxModelCalls: 512,
  maxToolCalls: 200,
} as const;
/** Old revisions retain their native caps. Explicit switches make task budgets
 * the single editable policy; hidden legacy defaults must not re-enable them. */
export function nativeExecutionLimits(
  runtime: { maxPlannerRounds: number; maxToolCalls: number },
  limits?: ExecutionBudgetLimits,
) {
  if (!limits?.enabled) return runtime;
  return {
    maxPlannerRounds: limits.enabled.maxModelCalls
      ? Math.min(100, limits.maxModelCalls)
      : 100,
    maxToolCalls: limits.enabled.maxToolCalls
      ? limits.maxToolCalls
      : PLATFORM_EXECUTION_LIMITS.maxToolCalls,
  };
}
export function configuredExecutionBudget(
  runtime: { maxPlannerRounds: number; maxToolCalls: number },
  collaboration?: Partial<ExecutionBudgetLimits> & { maxDelegations: number },
  executionLimits?: ExecutionBudgetLimits,
): ExecutionBudgetLimits {
  if (executionLimits)
    return {
      maxModelCalls:
        executionLimits.enabled?.maxModelCalls === false
          ? PLATFORM_EXECUTION_LIMITS.maxModelCalls
          : executionLimits.maxModelCalls,
      maxToolCalls:
        executionLimits.enabled?.maxToolCalls === false
          ? PLATFORM_EXECUTION_LIMITS.maxToolCalls
          : executionLimits.maxToolCalls,
      ...(executionLimits.enabled?.maxTotalTokens !== false &&
      executionLimits.maxTotalTokens !== undefined
        ? { maxTotalTokens: executionLimits.maxTotalTokens }
        : {}),
    };
  if (collaboration)
    return {
      maxModelCalls: collaboration.maxModelCalls ?? 32,
      maxToolCalls: collaboration.maxToolCalls ?? 40,
      maxTotalTokens: collaboration.maxTotalTokens ?? 120000,
    };
  return {
    maxModelCalls: runtime.maxPlannerRounds * 4 * (DEFAULT_MAX_TASKS + 1),
    maxToolCalls: runtime.maxToolCalls * (DEFAULT_MAX_TASKS + 1),
  };
}

export class SharedExecutionBudgetError extends AgentRunLimitError {
  constructor(readonly limit: "model_calls" | "tool_calls" | "tokens") {
    super();
    this.name = "SharedExecutionBudgetError";
  }
}
export class SharedExecutionBudget {
  readonly counters = {
    modelCalls: 0,
    toolCalls: 0,
    totalTokens: 0,
    reservedTokens: 0,
  };
  constructor(
    private readonly limits: {
      maxModelCalls: number;
      maxToolCalls: number;
      maxTotalTokens?: number;
    },
  ) {}
  /** Trusted persisted continuation only; reservations must settle before waiting. */
  restore(counters: typeof this.counters) {
    for (const value of Object.values(counters))
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError("Invalid execution budget continuation");
    if (
      counters.reservedTokens !== 0 ||
      counters.modelCalls > this.limits.maxModelCalls ||
      counters.toolCalls > this.limits.maxToolCalls ||
      (this.limits.maxTotalTokens !== undefined &&
        counters.totalTokens > this.limits.maxTotalTokens)
    ) throw new TypeError("Execution budget continuation exceeds limits");
    Object.assign(this.counters, counters);
  }
  takeTool(): boolean {
    if (this.counters.toolCalls >= this.limits.maxToolCalls) return false;
    this.counters.toolCalls++;
    return true;
  }
  reserveModel(estimate: number) {
    if (this.counters.modelCalls >= this.limits.maxModelCalls)
      throw new SharedExecutionBudgetError("model_calls");
    if (
      this.limits.maxTotalTokens !== undefined &&
      this.counters.totalTokens + this.counters.reservedTokens + estimate >
        this.limits.maxTotalTokens
    )
      throw new SharedExecutionBudgetError("tokens");
    this.counters.modelCalls++;
    this.counters.reservedTokens += estimate;
    let settled = false;
    const settle = (
      usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
      } | null,
    ) => {
      if (settled) return;
      settled = true;
      this.counters.reservedTokens -= estimate;
      const valid = (value: unknown): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0;
      const input = valid(usage?.inputTokens) ? usage.inputTokens : null;
      const output = valid(usage?.outputTokens) ? usage.outputTokens : null;
      const total = valid(usage?.totalTokens) ? usage.totalTokens : null;
      const known = (input ?? 0) + (output ?? 0);
      this.counters.totalTokens +=
        total !== null
          ? Math.max(total, known)
          : input !== null && output !== null
            ? known
            : Math.max(estimate, known);
      if (
        this.limits.maxTotalTokens !== undefined &&
        this.counters.totalTokens > this.limits.maxTotalTokens
      )
        throw new SharedExecutionBudgetError("tokens");
    };
    settle.cancel = () => {
      if (settled) return;
      settled = true;
      this.counters.modelCalls--;
      this.counters.reservedTokens -= estimate;
    };
    return settle;
  }
}
const scope = new AsyncLocalStorage<SharedExecutionBudget>();
export const currentExecutionBudget = () => scope.getStore();
export function withExecutionBudget<T>(
  budget: SharedExecutionBudget,
  operation: () => Promise<T>,
): Promise<T> {
  return scope.run(budget, operation);
}
