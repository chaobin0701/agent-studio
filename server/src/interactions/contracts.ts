import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type InteractionStatus = "pending" | "answered" | "approved" | "rejected" | "expired" | "cancelled";
export type QuestionRequest = {
  kind: "question";
  question: string;
  options: { id: string; label: string }[];
  allowCustom: boolean;
};
export type ApprovalRequest = {
  kind: "approval";
  toolName: string;
  description: string;
  toolVersionId: number;
  toolCallId: string;
  /** Exact normalized arguments, private until the host applies redaction. */
  arguments: JsonObject;
};
export type InteractionRequest = QuestionRequest | ApprovalRequest;
export type PublicInteraction = {
  id: string;
  runId: string;
  kind: "question" | "approval";
  status: InteractionStatus;
  revision: number;
  expiresAt: string;
  question?: string;
  options?: { id: string; label: string }[];
  allowCustom?: boolean;
  toolName?: string;
  description?: string;
  arguments?: JsonObject;
  answer?: { optionId?: string; text?: string };
};
export const interactionResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), interactionId: z.string().uuid(), revision: z.number().int().positive(), optionId: z.string().min(1).max(80).optional(), text: z.string().trim().min(1).max(4000).optional() }).strict()
    .refine((value) => Boolean(value.optionId) !== Boolean(value.text), "请选择一个选项或填写回答"),
  z.object({ kind: z.literal("approval"), interactionId: z.string().uuid(), revision: z.number().int().positive(), decision: z.enum(["approve", "reject"]) }).strict(),
]);
export type InteractionResponse = z.infer<typeof interactionResponseSchema>;
/** Host-owned bounded state, never sent to the client or passed in public JSON. */
export type RuntimeContinuationState = { harness?: JsonObject; execution?: JsonObject };
export type RuntimeInteractionHost = {
  checkpointer: BaseCheckpointSaver;
  threadId: string;
  resume?: { interruptId: string; value: JsonValue };
  continuation?: RuntimeContinuationState;
};
export class InteractionSuspension extends Error {
  readonly code = "interaction_required";
  constructor(readonly request: InteractionRequest, readonly interruptId: string, readonly continuation: RuntimeContinuationState = {}) {
    super("执行正在等待用户回应");
    this.name = "InteractionSuspension";
  }
}
/** A durable waiting result, intentionally distinct from a completed Run result. */
export class InteractionWaiting extends Error {
  readonly code = "interaction_required";
  constructor(readonly interaction: PublicInteraction) {
    super("执行正在等待用户回应");
    this.name = "InteractionWaiting";
  }
}
