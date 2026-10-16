import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { LLM_PROVIDER, LlmProvider } from '../ai/providers/llm-provider';

export type ContextPurpose = 'planner' | 'answer' | 'summary';
export type ContextPressure = 'normal' | 'elevated' | 'high' | 'overflow';

export type ContextBudget = {
  contextWindowTokens: number;
  inputBudgetTokens: number;
  maxOutputTokens: number;
  safetyBufferTokens: number;
  estimatedInputTokens: number;
  rawMessageCount: number;
  includedMessageCount: number;
  measurementSource: 'heuristic';
  pressure: ContextPressure;
  compacted: false;
  summaryCheckpointId: null;
  summarizedThroughSequence: null;
};

/** Safe, user-facing projection of a context budget. Values are heuristic estimates. */
export type ContextEstimate = {
  contextWindowTokens: number;
  inputBudgetTokens: number;
  estimatedInputTokens: number;
  remainingInputTokens: number;
  usagePercent: number;
  pressure: ContextPressure;
  measurementSource: 'heuristic';
};

export function contextEstimate(budget: ContextBudget | undefined): ContextEstimate | undefined {
  if (!budget) return undefined;
  const remainingInputTokens = Math.max(0, budget.inputBudgetTokens - budget.estimatedInputTokens);
  const usagePercent = budget.inputBudgetTokens > 0
    ? Math.min(100, Math.max(0, Number((budget.estimatedInputTokens / budget.inputBudgetTokens * 100).toFixed(1))))
    : 100;
  return {
    contextWindowTokens: budget.contextWindowTokens,
    inputBudgetTokens: budget.inputBudgetTokens,
    estimatedInputTokens: budget.estimatedInputTokens,
    remainingInputTokens,
    usagePercent,
    pressure: budget.pressure,
    measurementSource: budget.measurementSource,
  };
}

export type ContextGovernorInput = {
  systemPrompt: string;
  userPrompt: string;
  purpose: ContextPurpose;
  rawMessageCount?: number;
  includedMessageCount?: number;
};

export type DynamicMemoryLimits = {
  recentTurns: number;
  snapshotMessages: number;
  transcriptMaxMessages: number;
  transcriptMaxTraces: number;
  summaryTriggerMessages: number;
  summaryKeepMessages: number;
  summaryBatchMaxMessages: number;
  summaryMaxChars: number;
};

/** Derive memory bounds from the active model window; these are not user settings. */
export function memoryLimitsForContextWindow(contextWindowTokens: number): DynamicMemoryLimits {
  const scale = Math.max(0.25, Math.min(4, contextWindowTokens / 32_000));
  const recentTurns = Math.max(2, Math.min(20, Math.round(3 * Math.sqrt(scale))));
  const summaryKeepMessages = recentTurns * 2;
  return {
    recentTurns,
    snapshotMessages: Math.max(8, Math.min(80, recentTurns * 2)),
    transcriptMaxMessages: Math.max(40, Math.min(500, Math.round(120 * scale))),
    transcriptMaxTraces: Math.max(5, Math.min(100, Math.round(50 * Math.sqrt(scale)))),
    summaryTriggerMessages: Math.max(8, recentTurns * 4),
    summaryKeepMessages,
    summaryBatchMaxMessages: Math.max(24, Math.min(200, Math.round(100 * scale))),
    summaryMaxChars: Math.max(512, Math.min(6000, Math.round(1500 * Math.sqrt(scale)))),
  };
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_200;

@Injectable()
export class ContextGovernor {
  constructor(@Optional() private readonly config?: AppConfigService, @Optional() @Inject(LLM_PROVIDER) private readonly provider?: LlmProvider) {}

  inspect(input: ContextGovernorInput): ContextBudget {
    const contextWindowTokens = this.provider?.contextWindowTokens ?? this.config?.llm.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const maxOutputTokens = input.purpose === 'summary'
      ? 800
      : this.provider?.maxOutputTokens ?? this.config?.llm.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const safetyBufferTokens = Math.max(1_024, Math.ceil(contextWindowTokens * 0.05));
    const inputBudgetTokens = Math.max(0, contextWindowTokens - maxOutputTokens - safetyBufferTokens);
    const estimatedInputTokens = estimateTokens(`${input.systemPrompt}\n${input.userPrompt}`);
    const ratio = inputBudgetTokens > 0 ? estimatedInputTokens / inputBudgetTokens : 1;
    const pressure: ContextPressure = ratio < 0.7
      ? 'normal'
      : ratio < 0.85
        ? 'elevated'
        : ratio <= 1
          ? 'high'
          : 'overflow';
    return {
      contextWindowTokens,
      inputBudgetTokens,
      maxOutputTokens,
      safetyBufferTokens,
      estimatedInputTokens,
      rawMessageCount: input.rawMessageCount ?? 2,
      includedMessageCount: input.includedMessageCount ?? 2,
      measurementSource: 'heuristic',
      pressure,
      compacted: false,
      summaryCheckpointId: null,
      summarizedThroughSequence: null,
    };
  }
}

/** Conservative, dependency-free estimate until a provider tokenizer is available. */
export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 2));
}
