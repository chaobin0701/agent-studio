import { Injectable } from "@nestjs/common";
import { DeepAgentExecutionService } from "../deep-agents/deep-agent-execution.service";
import type { CompositionSnapshot } from "../../agent-management/runtime-scope";
import type {
  PlatformAgentInput,
  PlatformAgentCallbacks,
} from "./platform-input";
import type { AgentTaskInput } from "../agent/execution-contract";
import { executeAgentChat } from "../../chat/agent-chat-adapter";

/** One native host for published Chat and Run. No fallback or outer loop. */
@Injectable()
export class AgentExecutionService {
  constructor(private readonly deep: DeepAgentExecutionService) {}

  runTask(
    composition: CompositionSnapshot,
    task: AgentTaskInput,
    context: Parameters<DeepAgentExecutionService["runTask"]>[2],
    callbacks: PlatformAgentCallbacks = {},
  ) {
    return this.deep.runTask(composition, task, context, callbacks);
  }
  run(
    composition: CompositionSnapshot,
    input: PlatformAgentInput,
    callbacks: PlatformAgentCallbacks = {},
  ) {
    return executeAgentChat(this.deep, composition, input, callbacks);
  }
}
