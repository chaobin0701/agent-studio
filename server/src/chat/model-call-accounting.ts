import { AsyncLocalStorage } from "node:async_hooks";
import type { LlmRequest, LlmUsage } from "../ai/providers/provider.types";
import { currentExecutionBudget } from "../ai/agent/execution-budget";

export type ModelCallPurpose = "planner" | "answer" | "summary";
export type ModelCallLease = {
  settle: (usage: LlmUsage | null, error?: unknown) => Promise<void>;
};
export type ModelCallAccounting = {
  reserve: (
    request: LlmRequest,
    purpose: ModelCallPurpose,
  ) => Promise<ModelCallLease>;
};

// Per-request callbacks, not global mutable model settings. Async summaries inherit
// the originating application's accounting without putting storage in the native execution harness.
const accounting = new AsyncLocalStorage<ModelCallAccounting>();
export function withModelCallAccounting<T>(
  context: ModelCallAccounting,
  task: () => Promise<T>,
): Promise<T> {
  return accounting.run(context, task);
}
export async function reserveModelCall(
  request: LlmRequest,
  purpose: ModelCallPurpose,
): Promise<ModelCallLease | undefined> {
  const shared = currentExecutionBudget()?.reserveModel(
    modelInputReservation(request) + (request.maxTokens ?? 1200),
  );
  let lease: ModelCallLease | undefined;
  try {
    lease = await accounting.getStore()?.reserve(request, purpose);
  } catch (error) {
    shared?.cancel();
    throw error;
  }
  if (!shared && !lease) return undefined;
  return {
    settle: async (usage, error) => {
      // Accounting remains authoritative even if the shared budget was exceeded.
      try {
        await lease?.settle(usage, error);
      } finally {
        shared?.(usage);
      }
    },
  };
}

// A conservative UTF-8 bound, not a vendor tokenizer or an invoice estimate.
// Include tool schemas, transcript arguments and framing; never count just the question.
export function modelInputReservation(request: LlmRequest): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        messages: request.messages,
        tools: request.tools,
        responseFormat: request.responseFormat,
      }),
      "utf8",
    ) +
    1024 +
    request.messages.length * 32 +
    // Conservative bounded image reservation, never UTF-8/base64 byte length.
    (request.images ?? []).reduce(
      (sum, image) =>
        sum +
        2048 +
        4096 * Math.ceil(image.width / 512) * Math.ceil(image.height / 512),
      0,
    )
  );
}
