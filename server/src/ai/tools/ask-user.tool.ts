import { Injectable } from "@nestjs/common";
import { z } from "zod";
import type { AgentTool } from "./agent-tool";
import type { ToolContext } from "./tool-context";
import type { ToolResult } from "./tool-result";

export const questionSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  options: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().trim().min(1).max(200) }).strict()).max(8),
  allowCustom: z.boolean(),
}).strict().refine((value) => (value.options.length > 0 || value.allowCustom) &&
  new Set(value.options.map((option) => option.id)).size === value.options.length,
  "Question option IDs must be unique");

/** An explicitly bound platform tool. The native middleware collects the answer;
 * this gateway adapter validates that answer and closes the native call pair. */
@Injectable()
export class AskUserTool implements AgentTool<z.infer<typeof questionSchema>> {
  readonly name = "ask_user";
  readonly execution = { channel: "tools", source: "platform" } as const;
  readonly capabilities = ["human-question"] as const;
  readonly planning = { canBatch: false, isIdempotent: false };
  readonly runtimeLimits = { maxRetries: 0, timeoutMs: 1000 };
  readonly description = "缺少必要信息时向用户展示一个问题与可选项，可以允许自由填写。单独返回此工具调用；选择答案不代表批准任何外部操作。";
  readonly inputSchema = questionSchema;
  readonly parameters = z.toJSONSchema(questionSchema) as Record<string, unknown>;
  async execute(input: z.infer<typeof questionSchema>, context: ToolContext): Promise<ToolResult> {
    const answer = context.interactionAnswer;
    if (!answer) return { success: false, content: "当前入口未提供用户交互回答", errorCode: "interaction_transport_unavailable" };
    if ("skipped" in answer) return { success: true, content: JSON.stringify({ skipped: true, message: "用户跳过了这个问题。根据已知信息继续，不要推测缺失信息或重复询问同一个问题。" }) };
    const selected = answer.optionId && input.options.find((option) => option.id === answer.optionId);
    if (answer.optionId ? !selected || selected.label !== answer.text : !input.allowCustom)
      return { success: false, content: "用户回答与问题不匹配", errorCode: "interaction_response_invalid" };
    return { success: true, content: JSON.stringify({ text: answer.text, ...(answer.optionId ? { optionId: answer.optionId } : {}) }) };
  }
}
