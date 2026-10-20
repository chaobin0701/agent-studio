import { AIMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { assertSerializable } from "../agent/execution-contract";
import type { AgentTool } from "../tools/agent-tool";
import type { ToolContext } from "../tools/tool-context";
import { toolArgumentsHash } from "../tools/tool-context";
import type { InteractionRequest, JsonObject, QuestionRequest } from "../../interactions/contracts";
import { questionSchema } from "../tools/ask-user.tool";

type Grant = NonNullable<ToolContext["toolApproval"]>;
export type HumanInteractionState = {
  grants: Record<string, Grant>;
  answers: Record<string, { text: string; optionId?: string }>;
  rejected: Record<string, true>;
};
export const emptyHumanInteractionState = (): HumanInteractionState => ({ grants: Object.create(null), answers: Object.create(null), rejected: Object.create(null) });

/** Drop absent optional fields, but reject live objects rather than losing them. */
export function privateJson(value: unknown): JsonObject {
  const ancestors = new Set<object>();
  const clean = (item: unknown): unknown => {
    if (item && typeof item === "object") {
      if (ancestors.has(item)) throw new TypeError("Cyclic interaction continuation");
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new TypeError("Interaction continuation cannot contain live objects");
      ancestors.add(item);
      const result = Array.isArray(item) ? item.map(clean) : Object.fromEntries(Object.entries(item)
        .filter(([, child]) => child !== undefined).map(([key, child]) => [key, clean(child)]));
      ancestors.delete(item);
      return result;
    }
    return item;
  };
  const result = clean(value);
  assertSerializable(result);
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new TypeError("Invalid interaction continuation");
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
    throw new RangeError("Interaction continuation exceeds limit");
  return result as JsonObject;
}

export function interactionHash(value: unknown): string {
  return toolArgumentsHash(value);
}

/** Native afterModel interrupt boundary: preserve complete tool batches and order.
 * The platform gateway remains the sole authority for actual external calls. */
export function interactionMiddleware(
  tools: ReadonlyMap<string, AgentTool>,
  state: HumanInteractionState,
  enabled: boolean,
  canExecute: (tool: AgentTool, args: Record<string, unknown>) => boolean = () => true,
  unsupportedComposition = false,
) {
  const review = (tool: AgentTool, call: { id?: string; args: Record<string, unknown> }, normalized: unknown) => {
    if (!call.id || !Number.isSafeInteger(tool.execution?.toolVersionId))
      throw new Error("interaction_tool_identity_invalid");
    const args = privateJson(normalized);
    const request: InteractionRequest = {
      kind: "approval", toolName: tool.name, description: tool.description,
      toolVersionId: tool.execution!.toolVersionId!, toolCallId: call.id, arguments: args,
    };
    const raw: unknown = interrupt({ type: "agent_studio_interaction", request });
    const decision = z.object({ decision: z.enum(["approve", "reject"]) }).strict().parse(raw);
    if (decision.decision === "approve") {
      state.grants[call.id] = { toolCallId: call.id,
        toolVersionId: tool.execution!.toolVersionId!, argumentsHash: interactionHash(args) };
      delete state.rejected[call.id];
      return true;
    }
    delete state.grants[call.id];
    state.rejected[call.id] = true;
    return false;
  };
  return createMiddleware({
    name: "PlatformHumanInteraction",
    afterModel: (graphState) => {
      const last = graphState.messages.at(-1);
      if (!last || !AIMessage.isInstance(last) || !last.tool_calls?.length) return;
      for (const call of last.tool_calls) {
        const tool = tools.get(call.name);
        if (tool && !canExecute(tool, call.args)) continue;
        if (tool?.capabilities?.includes("human-question")) {
          if (!enabled) throw new Error(unsupportedComposition ? "interaction_mode_unsupported" : "interaction_transport_unavailable");
          if (!call.id || last.tool_calls.length !== 1)
            throw new Error("interaction_batch_unsupported");
          const published = tool.inputSchema.safeParse(call.args);
          if (!published.success) continue;
          const parsedQuestion = questionSchema.safeParse(published.data);
          if (!parsedQuestion.success) continue;
          if (tool.execution?.requiresApproval && !review(tool, call, published.data)) continue;
          const question = parsedQuestion.data;
          const request: QuestionRequest = { kind: "question", ...question };
          const raw: unknown = interrupt({ type: "agent_studio_interaction", request });
          const answer = z.object({ optionId: z.string().max(80).optional(), text: z.string().trim().min(1).max(4000) }).strict().parse(raw);
          if (answer.optionId) {
            const option = question.options.find((item) => item.id === answer.optionId);
            if (!option || answer.text !== option.label) throw new TypeError("Invalid question option response");
          } else if (!question.allowCustom) throw new TypeError("Custom answers are not allowed");
          state.answers[call.id] = answer;
          continue;
        }
        if (!tool?.execution?.requiresApproval) continue;
        if (!enabled) {
          if (unsupportedComposition) throw new Error("interaction_mode_unsupported");
          continue;
        }
        const normalized = tool.inputSchema.safeParse(call.args);
        // Invalid calls go through the ordinary gateway validation; never ask a
        // human to approve an operation that cannot be executed as shown.
        if (!normalized.success) continue;
        review(tool, call, normalized.data);
      }
    },
  });
}

