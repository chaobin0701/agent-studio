import "reflect-metadata";
import assert from "node:assert/strict";
import { LlmService } from "../../dist/chat/llm.service.js";
import { ChatOrchestratorService } from "../../dist/chat/chat-orchestrator.service.js";
import { DeepAgentExecutionService } from "../../dist/ai/deep-agents/deep-agent-execution.service.js";
import { AgentExecutionService } from "../../dist/ai/runtime/agent-execution.service.js";
import { ToolRegistry } from "../../dist/ai/tools/tool-registry.js";
import { ToolExecutionService } from "../../dist/ai/tools/tool-execution.js";
import { ToolPolicy } from "../../dist/ai/tools/tool-policy.js";
import { agentSchema } from "../../dist/agent-management/resource.types.js";
import {
  DEFAULT_AGENT_CONFIGURATION,
  agentConfigurationRevision,
} from "../../dist/config/agent-config.js";
import { freeze } from "../../dist/agent-management/runtime-scope.js";

/** Real native framework + platform model/tool governance; only the supplier
 * response and published resource storage are deterministic fixture boundaries.
 * No legacy runner/loop, transcript replay or static execution fallback. */
export function nativeChat({
  respond,
  tools = [],
  skills = [],
  knowledge = [],
  businessPrompt = "Complete the authorized task",
  configurationVersion = 1,
  configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION),
  memory,
  tracing,
} = {}) {
  configuration = structuredClone(configuration);
  const requests = [];
  let finished = false;
  const provider = {
    model: "native-chat-fixture",
    contextWindowTokens: 32000,
    maxOutputTokens: 2400,
    maxRetries: 0,
    async *stream(request) {
      finished = false;
      request.signal?.throwIfAborted();
      requests.push(structuredClone({ ...request, signal: undefined }));
      const reply = await respond(request, requests.length);
      assert.ok(reply, "Unexpected extra model call");
      for (const delta of reply.content ?? "") {
        request.signal?.throwIfAborted();
        yield { type: "text_delta", delta };
        await new Promise(setImmediate);
      }
      for (const [index, call] of (reply.toolCalls ?? []).entries())
        yield {
          type: "tool_call_delta",
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: JSON.stringify(call.arguments),
        };
      if (reply.wait) {
        let abort;
        try {
          await Promise.race([
            reply.wait,
            new Promise((_, reject) => {
              abort = () => reject(request.signal.reason);
              request.signal?.addEventListener("abort", abort, { once: true });
            }),
          ]);
        } finally {
          if (abort) request.signal?.removeEventListener("abort", abort);
        }
      }
      request.signal?.throwIfAborted();
      finished = true;
      yield {
        type: "completed",
        usage: reply.usage ?? {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
        finishReason:
          reply.finishReason ??
          (reply.toolCalls?.length ? "tool_calls" : "stop"),
      };
    },
    async chat(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const reply = await respond(request, requests.length);
      assert.ok(reply, "Unexpected extra model call");
      if (reply.wait) await reply.wait;
      return {
        model: provider.model,
        content: reply.content ?? "",
        toolCalls: reply.toolCalls ?? [],
        usage: reply.usage ?? {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
        finishReason:
          reply.finishReason ??
          (reply.toolCalls?.length ? "tool_calls" : "stop"),
      };
    },
  };
  const llm = new LlmService(provider);
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const { allowedTools: _allowed, ...runtime } = configuration.runtime;
  const spec = agentSchema.parse({
    responsibility: "Native Chat fixture",
    promptVersionId: 1,
    modelPlanVersionId: 1,
    toolVersionIds: [],
    skillVersionIds: [],
    knowledgeBaseIds: knowledge.map((base) => base.id),
    runtime,
  });
  configuration.runtime = {
    ...spec.runtime,
    allowedTools: tools.map((tool) => tool.name),
  };
  configuration.enabledSkills = skills.map((skill) => skill.id);
  const entry = {
    version: {
      id: 1,
      resourceId: 101,
      key: "fixture",
      name: "Fixture",
      status: "published",
      version: configurationVersion,
    },
    spec,
    configurationSnapshot: {
      configuration,
      revision: agentConfigurationRevision(configuration),
      configurationVersion,
      updatedAt: null,
      updatedBy: null,
    },
    promptSnapshot: {
      environment: "dev",
      prompts: {},
      businessPrompt,
    },
    modelPlan: null,
    embeddingPlan: null,
    knowledge,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    skills: new Map(skills.map((skill) => [skill.id, skill])),
    skillSpecs: new Map(),
  };
  const snapshot = freeze({
    workspaceId: 1,
    agentId: 101,
    mode: "single",
    environment: "dev",
    entryVersionId: 1,
    agents: new Map([[1, entry]]),
    createdAt: new Date().toISOString(),
  });
  const gateway = new ToolExecutionService(
    registry,
    new ToolPolicy({ agent: configuration }),
  );
  const execution = new AgentExecutionService(
    new DeepAgentExecutionService(llm, gateway, tracing),
  );
  const management = { snapshot: async () => snapshot };
  const orchestrator = new ChatOrchestratorService(
    execution,
    llm,
    management,
    memory,
  );
  return {
    orchestrator,
    execution,
    llm,
    registry,
    gateway,
    snapshot,
    requests,
    runner: {
      run: (input, callbacks) => execution.run(snapshot, input, callbacks),
    },
    get finished() {
      return finished;
    },
  };
}
