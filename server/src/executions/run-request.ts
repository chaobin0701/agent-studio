import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import type {
  AgentFinalOutput,
  AgentTaskInput,
} from "../ai/agent/execution-contract";
import type { CompositionSnapshot } from "../agent-management/runtime-scope";
import type { PublicAgentResult } from "../integrations/integration.types";
import { credentialHash } from "../integrations/integration.service";
import {
  configuredExecutionBudget,
  nativeExecutionLimits,
} from "../ai/agent/execution-budget";
import { outputTask, OutputContractError } from "../ai/agent/output-contract";
import { validatedOutputSchema } from "../ai/deep-agents/output-schema";

const text = z.string().trim().min(1).max(2000);
export const runRequestSchema = z
  .object({
    userId: z.string().trim().min(1).max(128).optional(),
    task: text.optional(),
    outputSchema: z
      .unknown()
      .transform((schema, context) => {
        try {
          return validatedOutputSchema(schema);
        } catch (error) {
          for (const issue of error instanceof OutputContractError
            ? error.issues
            : [{ path: "$", message: "输出规范无效" }])
            context.addIssue({
              code: "custom",
              path: issue.path.split(".").filter((p) => p !== "$"),
              message: issue.message,
            });
          return z.NEVER;
        }
      })
      .optional(),
    messages: z
      .array(
        z
          .object({ role: z.enum(["user", "assistant"]), content: text })
          .strict(),
      )
      .max(30)
      .default([]),
    attachments: z
      .array(
        z
          .object({
            kind: z.literal("document"),
            id: z.string().regex(/^[1-9][0-9]{0,14}$/u),
          })
          .strict(),
      )
      .max(5)
      .default([]),
    limits: z
      .object({
        maxDecisions: z.number().int().min(1).max(100).optional(),
        maxToolCalls: z.number().int().min(0).max(100).optional(),
        maxDurationMs: z.number().int().min(1).max(180000).optional(),
        maxModelCalls: z.number().int().min(1).max(512).optional(),
        maxTotalTokens: z.number().int().min(1).max(1000000).optional(),
      })
      .strict()
      .default({}),
    stream: z.boolean().default(false),
  })
  .strict()
  .refine(
    (input) => Boolean(input.task || input.messages.at(-1)?.role === "user"),
    "A task or final user message is required",
  );
export type RunRequest = z.infer<typeof runRequestSchema>;
export type PublicRunResult = Omit<AgentFinalOutput, "usage"> & {
  runId: string;
  traceId: string;
  agentId: number;
  agentVersionId: number;
  /** Billing authority is the existing model-attempt ledger, including retries. */
  usage?: PublicAgentResult["usage"];
};
export function parseRunRequest(value: unknown): RunRequest {
  const result = runRequestSchema.safeParse(value);
  if (!result.success)
    throw new BadRequestException({
      message: "Run 输入无效，请检查任务、附件、输出规范和执行上限",
      issues: result.error.issues
        .slice(0, 12)
        .map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return result.data;
}
export function runFingerprint(agentId: number, input: RunRequest): string {
  // Stream is transport only. Replays keep the original fixed configuration/result.
  return credentialHash(
    JSON.stringify([
      "generic-run-v1",
      agentId,
      input.task ?? null,
      input.messages,
      input.attachments,
      Object.entries(input.limits).sort(([a], [b]) => a.localeCompare(b)),
      ...(input.outputSchema ? [input.outputSchema] : []),
    ]),
  );
}
export function pinnedTaskInput(
  composition: CompositionSnapshot,
  input: RunRequest,
  runId: string,
  traceId: string,
): AgentTaskInput {
  const entry = composition.agents.get(composition.entryVersionId)!;
  const configured = configuredExecutionBudget(
    entry.spec.runtime,
    composition.collaboration,
    entry.spec.executionLimits,
  );
  const sharedToolLimit = configured.maxToolCalls;
  const sharedModelLimit = configured.maxModelCalls;
  const native = nativeExecutionLimits(
    entry.spec.runtime,
    entry.spec.executionLimits,
  );
  return {
    messages: input.messages,
    ...(input.task ? { task: input.task } : {}),
    ...outputTask(entry.spec.output, entry.version.id, input.outputSchema),
    attachments: input.attachments,
    versions: {
      workspaceId: composition.workspaceId,
      agentId: composition.agentId,
      agentVersionId: entry.version.id,
      promptVersionId: entry.spec.promptVersionId,
      modelPlanVersionId: entry.modelPlan?.id ?? null,
      embeddingPlanVersionId: entry.embeddingPlan?.id ?? null,
      localRunId: runId,
      localTraceId: traceId,
    },
    limits: {
      ...input.limits,
      maxDecisions: Math.min(
        native.maxPlannerRounds,
        input.limits.maxDecisions ?? native.maxPlannerRounds,
      ),
      maxToolCalls: Math.min(
        sharedToolLimit,
        input.limits.maxToolCalls ?? sharedToolLimit,
      ),
      maxModelCalls: Math.min(
        sharedModelLimit,
        input.limits.maxModelCalls ?? sharedModelLimit,
      ),
      ...(input.limits.maxTotalTokens !== undefined ||
      configured.maxTotalTokens !== undefined
        ? {
            maxTotalTokens: Math.min(
              input.limits.maxTotalTokens ?? Infinity,
              configured.maxTotalTokens ?? Infinity,
            ),
          }
        : {}),
      maxDurationMs: input.limits.maxDurationMs ?? 180000,
    },
  };
}
