import { TestExecutionTracer } from "./helpers/trace-collector.mjs";
import { collectOtlpSpans } from "./helpers/trace-collector.mjs";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { AgentExecutionService } from "../dist/ai/runtime/agent-execution.service.js";
import { DeepAgentExecutionService } from "../dist/ai/deep-agents/deep-agent-execution.service.js";
import { ToolRegistry } from "../dist/ai/tools/tool-registry.js";
import { ToolExecutionService } from "../dist/ai/tools/tool-execution.js";
import { ToolPolicy } from "../dist/ai/tools/tool-policy.js";
import { LlmService } from "../dist/chat/llm.service.js";
import { ChatOrchestratorService } from "../dist/chat/chat-orchestrator.service.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
import {
  agentSchema,
  agentCollaborationSchema,
} from "../dist/agent-management/resource.types.js";
import {
  runtimeScope,
  freeze,
} from "../dist/agent-management/runtime-scope.js";
import {
  SharedExecutionBudget,
  SharedExecutionBudgetError,
  withExecutionBudget,
} from "../dist/ai/agent/execution-budget.js";
import {
  withModelCallAccounting,
  reserveModelCall,
} from "../dist/chat/model-call-accounting.js";
import { ProviderUnavailableError } from "../dist/ai/providers/provider-errors.js";
import { evidenceDigest } from "../dist/ai/context/context-contribution.js";
import { KnowledgeSearchTool } from "../dist/ai/tools/knowledge-search.tool.js";
import { executionContextView } from "../dist/observability/execution-view.js";
import { ProviderAuthenticationError } from "../dist/ai/providers/provider-errors.js";

const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
const final = (answer) => ({
  content: JSON.stringify({
    type: "final",
    status: "answered",
    answer,
    citationIds: [],
  }),
  toolCalls: [],
  finishReason: "stop",
});
function fixture(limits = {}, handler) {
  const plans = new AsyncLocalStorage(),
    requests = [],
    exported = [];
  let rootRounds = 0;
  const provider = {
    get model() {
      return `model-${plans.getStore()?.id ?? 1}`;
    },
    contextWindowTokens: 32000,
    maxOutputTokens: 300,
    withPlan: async (task) => task(),
    withPlanVersion: (plan, task) => plans.run(plan, task),
    planMetadata: () => ({
      versionId: plans.getStore().id,
      planId: plans.getStore().id,
      version: 1,
    }),
    attemptPlan: () => [
      {
        provider,
        versionId: plans.getStore().id,
        deploymentId: plans.getStore().id + 1000,
        deploymentAttempt: 1,
        maxRetries: 0,
      },
    ],
    async *stream(request) {
      const response = await provider.chat(request);
      if (response.content)
        yield { type: "text_delta", delta: response.content };
      for (const [index, call] of response.toolCalls.entries())
        yield {
          type: "tool_call_delta",
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: JSON.stringify(call.arguments),
        };
      yield {
        type: "completed",
        usage: response.usage,
        finishReason: response.finishReason,
      };
    },
    chat: async (request) => {
      const agent = runtimeScope.getStore();
      requests.push({
        id: agent.version.id,
        request: structuredClone({ ...request, signal: undefined }),
      });
      if (handler)
        return {
          ...(await handler(request, requests.length)),
          model: request.model,
          usage,
        };
      let response;
      if (agent.version.id === 1) {
        rootRounds++;
        response =
          rootRounds === 1
            ? {
                content: "",
                toolCalls: [
                  {
                    id: "first-member",
                    name: "task",
                    arguments: {
                      subagent_type: "member_one",
                      description: "First explicit task",
                    },
                  },
                  {
                    id: "deferred-member",
                    name: "task",
                    arguments: {
                      subagent_type: "member_two",
                      description: "Second explicit task",
                    },
                  },
                ],
                finishReason: "tool_calls",
              }
            : final("Consolidated answer");
      } else if (
        agent.version.id === 2 &&
        !request.messages.some((m) => m.role === "tool")
      ) {
        response = {
          content: "",
          toolCalls: [
            {
              id: "member-skill",
              name: "read_file",
              arguments: { file_path: "/skills/specialist/SKILL.md" },
            },
          ],
          finishReason: "tool_calls",
        };
      } else response = final(`Answer ${agent.version.id}`);
      return { ...response, model: request.model, usage };
    },
  };
  const llm = new LlmService(provider),
    registry = new ToolRegistry(),
    toolRuntime = new ToolExecutionService(registry, new ToolPolicy());
  const tracer = new TestExecutionTracer(
    { enabled: true, project: "fixture" },
    collectOtlpSpans(exported),
  );
  const resolve = (id, key) => {
    const tools = new Map();
    const spec = agentSchema.parse({
      responsibility: `Responsibility ${id}`,
      promptVersionId: id,
      modelPlanVersionId: id,
      toolVersionIds: [],
      skillVersionIds: id === 2 ? [62] : [],
      knowledgeBaseIds: [],
      runtime: {},
    });
    const configuration = structuredClone(DEFAULT_AGENT_CONFIGURATION);
    configuration.identity = {
      name: key,
      role: `Responsibility ${id}`,
      persona: `Prompt ${id}`,
    };
    configuration.answeringInstructions = "Complete the task";
    configuration.answerInstructions = "Respond clearly";
    configuration.runtime = {
      ...spec.runtime,
      allowedTools: [...tools.keys()],
    };
    configuration.enabledSkills = id === 2 ? ["specialist"] : [];
    const guide = {
      id: "specialist",
      name: "Guide",
      version: "1",
      description: "Member guide",
      systemInstructions: "GUIDE_FOR_MEMBER",
    };
    return {
      version: {
        id,
        resourceId: id + 100,
        key,
        name: key,
        version: 1,
        status: "published",
        enabled: true,
      },
      spec,
      configurationSnapshot: {
        configuration,
        revision: `rev-${id}`,
        configurationVersion: 1,
      },
      promptSnapshot: {
        environment: "dev",
        prompts: {},
        businessPrompt: `Prompt ${id}`,
        delegationHints: id === 1 ? "member_one, member_two" : "",
      },
      modelPlan: { id, plan_id: id, version: 1 },
      embeddingPlan: null,
      tools,
      skills: new Map(id === 2 ? [["specialist", guide]] : []),
      skillSpecs: new Map(
        id === 2
          ? [
              [
                "specialist",
                {
                  permissionMode: "agent",
                  allowedTools: [],
                  allowedKnowledgeBaseIds: [],
                },
              ],
            ]
          : [],
      ),
      skillPolicies: new Map(),
      knowledge: [],
    };
  };
  const collaboration = {
    ...agentCollaborationSchema.parse({ memberVersionIds: [2, 3], ...limits }),
    coordinatorVersionId: 1,
    maxDepth: 1,
    edges: [
      { from: 1, to: 2 },
      { from: 1, to: 3 },
    ],
  };
  const snapshot = freeze({
    workspaceId: 1,
    agentId: 101,
    environment: "dev",
    mode: "multi",
    entryVersionId: 1,
    createdAt: "now",
    collaboration,
    agents: new Map([
      [1, resolve(1, "entry")],
      [2, resolve(2, "member_one")],
      [3, resolve(3, "member_two")],
    ]),
  });
  const input = {
    question: "PRIVATE_ROOT_QUESTION",
    summary: "PRIVATE_ROOT_SUMMARY",
    recentHistory: [
      { question: "PRIVATE_ROOT_HISTORY", answer: "PRIVATE_ROOT_ANSWER" },
    ],
    priorTranscript: [],
    requestContext: { productIds: ["PRIVATE_ROOT_REFERENCE"] },
    runId: "run-fixture",
    traceId: "trace-fixture",
  };
  return {
    service: new AgentExecutionService(
      new DeepAgentExecutionService(llm, toolRuntime, tracer),
    ),
    llm,
    snapshot,
    input,
    requests,
    exported,
    tracer,
    toolRuntime,
  };
}

function singleSnapshot(f, tools = []) {
  const original = f.snapshot.agents.get(1);
  const entry = {
    ...original,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    skills: new Map(),
    skillSpecs: new Map(),
    spec: {
      ...original.spec,
      skillVersionIds: [],
      knowledgeBaseIds: tools.some((tool) => tool.name === "search_knowledge")
        ? [7]
        : [],
    },
    knowledge: tools.some((tool) => tool.name === "search_knowledge")
      ? [{ id: 7, indexVersionId: 71 }]
      : [],
    configurationSnapshot: {
      ...original.configurationSnapshot,
      configuration: {
        ...original.configurationSnapshot.configuration,
        enabledSkills: [],
        runtime: {
          ...original.spec.runtime,
          allowedTools: tools.map((tool) => tool.name),
        },
      },
    },
  };
  return {
    ...f.snapshot,
    mode: "single",
    collaboration: null,
    agents: new Map([[1, entry]]),
  };
}

test("published Chat streams native output once, retains bounded public history and never replays old tool/body state", async () => {
  const f = fixture({}, (request) => {
    assert.ok(
      request.messages.some(
        (message) => message.content === "PRIVATE_ROOT_HISTORY",
      ),
    );
    assert.ok(
      !request.tools.some((tool) =>
        ["task", "execute", "delegate_agent", "run_skill"].includes(tool.name),
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(request.messages),
      /PRIVATE_OLD_TOOL_BODY|PRIVATE_ROOT_SUMMARY/,
    );
    return {
      ...final("Native public answer"),
      content: "Native public answer",
    };
  });
  const snapshot = singleSnapshot(f),
    deltas = [],
    started = [],
    progress = [];
  const chat = new ChatOrchestratorService(f.service, f.llm, {
    snapshot: async () => snapshot,
  });
  const result = await chat.askDetailed(
    f.input.question,
    f.input.recentHistory,
    f.input.summary,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      onAnswerStarted: (value) => started.push(value),
      onAnswerDelta: (value) => deltas.push(value),
      onProgress: (value) => progress.push(value),
    },
    {
      compositionSnapshot: snapshot,
      conversationId: "chat-native",
      traceId: "trace-native",
      priorTranscript: [
        {
          role: "tool",
          toolName: "search_knowledge",
          content: "PRIVATE_OLD_TOOL_BODY",
        },
      ],
    },
  );
  assert.equal(f.requests.length, 1);
  assert.deepEqual(deltas, ["Native public answer"]);
  assert.equal(started.length, 1);
  assert.equal(result.contextSnapshot.executionEngine, "deepagents");
  assert.deepEqual(
    result.contextSnapshot.agentTranscript.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.deepEqual(result.contextSnapshot.runtimeContextBlocks, []);
  assert.ok(
    progress.some(
      (event) => event.stage === "answer" && event.status === "completed",
    ),
  );
  assert.equal(result.totalTokens, 5);
  await f.tracer.flush();
});

const memoryHit = {
  chunkId: 42,
  documentId: 17,
  documentTitle: "Verified policy",
  originalFilename: "policy.md",
  headingPath: "Policy",
  content: "PRIVATE_CURRENT_RESOURCE_BODY",
  sourceStartLine: 1,
  sourceEndLine: 2,
  score: 0.8,
  knowledgeBaseId: 7,
  indexVersionId: 71,
  indexKind: "published",
};
test("native Chat exposes revision-checked memory lazily, revalidates at read time and persists real citations/context blocks", async () => {
  let validations = 0;
  const search = new KnowledgeSearchTool({});
  const f = fixture({}, (request, count) => {
    if (count === 1) {
      assert.doesNotMatch(
        JSON.stringify(request.messages),
        /PRIVATE_CURRENT_RESOURCE_BODY|PRIVATE_OLD_TOOL_BODY/,
      );
      return {
        content: "",
        toolCalls: [
          {
            id: "context-read",
            name: "read_file",
            arguments: { file_path: "/context/resource-1.json" },
          },
        ],
        finishReason: "tool_calls",
      };
    }
    assert.match(
      request.messages.at(-1).content,
      /PRIVATE_CURRENT_RESOURCE_BODY/,
    );
    return {
      ...final("Current policy confirmed"),
      content: JSON.stringify({
        answer: "Current policy confirmed",
        citationIds: [42],
      }),
    };
  });
  const resource = {
    kind: "knowledge",
    key: "knowledge:published:71:42",
    data: memoryHit,
    digest: evidenceDigest(memoryHit),
  };
  const result = await f.service.run(singleSnapshot(f, [search]), {
    ...f.input,
    summary: "",
    requestContext: undefined,
    conversationId: "chat-memory",
    restoredContext: {
      resources: [resource],
      products: [],
      evidence: [memoryHit],
      historyProductIds: [],
      diagnostics: { enabled: true, candidates: 1, restored: 1, omitted: 0 },
    },
    validateContextResource: async (value, signal) => {
      signal.throwIfAborted();
      assert.equal(value.digest, resource.digest);
      validations++;
    },
  });
  assert.equal(validations, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(result.result.citations[0].documentId, 17);
  assert.equal(result.contextSnapshot.runtimeContextBlocks[0].origin, "host");
  assert.equal(
    result.contextSnapshot.runtimeContextBlocks[0].resources[0].digest,
    resource.digest,
  );
  assert.equal(
    result.contextSnapshot.toolCalls.filter(
      (tool) => tool.name === "search_knowledge",
    ).length,
    0,
    "restoration is not a fake search",
  );
  await f.tracer.flush();
});

test("native Chat refuses resource reads after removal, with no old body replay or fallback model", async () => {
  const f = fixture({}, () => ({
    content: "",
    toolCalls: [
      {
        id: "read",
        name: "read_file",
        arguments: { file_path: "/context/resource-1.json" },
      },
    ],
    finishReason: "tool_calls",
  }));
  const resource = {
    kind: "knowledge",
    key: "knowledge:published:71:42",
    data: memoryHit,
    digest: evidenceDigest(memoryHit),
  };
  await assert.rejects(
    f.service.run(singleSnapshot(f, [new KnowledgeSearchTool({})]), {
      ...f.input,
      summary: "",
      requestContext: undefined,
      restoredContext: {
        resources: [resource],
        products: [],
        evidence: [memoryHit],
      },
      validateContextResource: async () => {
        throw Error("Context resource is unavailable");
      },
    }),
    /Context resource is unavailable/,
  );
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(
    JSON.stringify(f.requests),
    /PRIVATE_CURRENT_RESOURCE_BODY/,
  );
  await f.tracer.flush();
});

test("native Chat failures retain Chat identity and safe failed model/attempt details, never provider body", async () => {
  const f = fixture({}, () => {
    const error = new ProviderAuthenticationError(401);
    error.message = "PRIVATE_VENDOR_DIAGNOSTIC";
    throw error;
  });
  f.llm.logger.warn = () => {};
  let context;
  await assert.rejects(
    f.service.run(
      singleSnapshot(f),
      { ...f.input, conversationId: "chat-failed" },
      {
        onContext: (value) => {
          context = value;
        },
        onAnswerDelta: () => assert.fail("Failed provider must not emit text"),
      },
    ),
  );
  assert.equal(f.requests.length, 1);
  assert.equal(context.entryPoint, "chat");
  assert.equal(context.errorSummary.errorCode, "provider_authentication");
  assert.equal(context.executionSteps[0].ok, false);
  assert.equal(context.modelCalls[0].attemptsTrail.length, 1);
  assert.equal(context.modelCalls[0].attempts, 1);
  const view = executionContextView(context);
  assert.notEqual(view.entryPoint, "generic_run");
  assert.equal(view.models[0].ok, false);
  assert.equal(view.models[0].errorCode, "provider_authentication");
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/);
  await f.tracer.flush();
});

test("native published Chat knowledge search uses own pinned index/retrieval and persists only real capability references", async () => {
  let searchCalls = 0;
  const tool = new KnowledgeSearchTool({
    searchForAgent: async (query, limit, knowledge, retrieval) => {
      searchCalls++;
      assert.equal(query, "Policy query");
      assert.equal(limit, 5);
      assert.deepEqual(knowledge, [{ id: 7, indexVersionId: 71 }]);
      assert.equal(retrieval.retrievalMode, "fulltext");
      return {
        hits: [memoryHit],
        retrievalMode: "lexical-only",
        vectorIndexedChunks: 0,
        embeddingCalls: 0,
      };
    },
  });
  const f = fixture({}, (_request, count) =>
    count === 1
      ? {
          content: "",
          toolCalls: [
            {
              id: "rag",
              name: "search_knowledge",
              arguments: { query: "Policy query", topK: 8 },
            },
          ],
          finishReason: "tool_calls",
        }
      : {
          ...final("Confirmed policy"),
          content: JSON.stringify({
            answer: "Confirmed policy",
            citationIds: [42, 999],
          }),
        },
  );
  const result = await f.service.run(singleSnapshot(f, [tool]), {
    ...f.input,
    summary: "",
    requestContext: undefined,
    conversationId: "chat-rag",
  });
  assert.equal(searchCalls, 1);
  assert.equal(result.result.citations.length, 1);
  assert.equal(result.result.citations[0].chunkId, 42);
  assert.equal(
    result.contextSnapshot.runtimeContextBlocks[0].toolCallId,
    "rag",
  );
  assert.equal(result.totalTokens, 10);
  await f.tracer.flush();
});

test("formal Chat uses native Deep Agents with two authorized members and lazy member Skill, isolated history/files and one usage aggregation", async () => {
  const f = fixture();
  const progress = [];
  const result = await f.service.run(f.snapshot, f.input, { onProgress: event => progress.push(event) });
  await f.tracer.flush();
  assert.equal(progress.filter(event => event.tool === "delegate_agent" && event.status === "running").length, 2);
  assert.equal(progress.filter(event => event.tool === "delegate_agent" && event.status === "completed" && event.ok).length, 2);
  assert.equal(JSON.stringify(progress).includes("PRIVATE_ROOT"), false);
  assert.equal(result.result.answer, "Consolidated answer");
  assert.equal(result.totalTokens, 25);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(result.contextSnapshot.executionBudget, {
    modelCalls: 5,
    toolCalls: 3,
    totalTokens: 25,
    reservedTokens: 0,
    maxModelCalls: 32,
    maxToolCalls: 8,
    maxTotalTokens: 120000,
  });
  const tasks = result.contextSnapshot.specialistTasks;
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks
      .filter((t) => t.type === "delegate_agent")
      .map((t) => t.agentVersionId),
    [2, 3],
  );
  assert.ok(tasks.every((t) => t.context.executionEngine === "deepagents"));
  assert.equal(result.contextSnapshot.executionEngine, "deepagents");
  assert.equal(result.contextSnapshot.entryPoint, "chat");
  assert.ok(result.contextSnapshot.graphNodes.includes("task"));
  assert.ok(
    tasks
      .find((t) => t.type === "delegate_agent" && t.agentVersionId === 2)
      .context.graphNodes.includes("skills"),
  );
  assert.ok(
    !result.toolCalls.some(
      (t) => t.name === "run_skill" || t.name === "delegate_agent",
    ),
  );
  for (const { id, request } of f.requests) {
    assert.equal(request.model, `model-${id}`);
    if (id !== 1) assert.doesNotMatch(JSON.stringify(request), /PRIVATE_ROOT/);
  }
  const skill = f.requests.find(
    ({ id, request }) =>
      id === 2 && request.messages.some((m) => m.role === "tool"),
  );
  assert.match(
    skill.request.messages.find((m) => m.role === "tool").content,
    /GUIDE_FOR_MEMBER/,
  );
  assert.equal(
    skill.request.messages.find((m) => m.role === "user").content,
    "First explicit task",
  );
  const roots = f.exported.filter((r) => r.name === "deep_agent");
  assert.equal(roots.length, 3);
  assert.equal(new Set(roots.map((r) => r.traceId)).size, 1);
  assert.equal(f.exported.filter((r) => r.name === "member_agent").length, 2);
  assert.equal(
    f.exported.filter((r) => r.name === "workspace_read_file").length,
    1,
  );
  assert.equal(f.exported.filter((r) => r.name === "model_attempt").length, 5);
  const automatic = f.exported.filter(r => r.attributes["app.layer"] === "framework");
  assert.ok(automatic.length > 3, "real framework internal nodes are automatically captured");
  assert.ok(automatic.every(r => r.attributes["openinference.span.kind"] === "CHAIN"));
  assert.ok(automatic.every(r => !Object.keys(r.attributes).some(k => /llm.token_count|input.value|output.value/.test(k))));
  assert.equal(new Set(automatic.map(r => r.spanId)).size, automatic.length, "no duplicate framework callback spans");
  assert.doesNotMatch(
    JSON.stringify(f.exported),
    /PRIVATE_ROOT|GUIDE_FOR_MEMBER|Prompt 2/,
  );
});

test("formal member Skill auxiliary reads are isolated, lazy, budgeted and metadata-only in LangSmith", async () => {
  let rootRounds = 0;
  const f = fixture({}, async (request) => {
    const id = runtimeScope.getStore().version.id;
    if (id === 1) {
      rootRounds++;
      assert.doesNotMatch(JSON.stringify(request), /PRIVATE_MEMBER_RESOURCE/);
      return rootRounds === 1
        ? {
            content: "",
            toolCalls: [
              {
                id: "aux-member",
                name: "task",
                arguments: {
                  subagent_type: "member_one",
                  description: "Read your own reference",
                },
              },
            ],
            finishReason: "tool_calls",
          }
        : final("Consolidated reference answer");
    }
    assert.equal(id, 2);
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE_ROOT/);
    const readCount = request.messages.filter(
      (message) => message.role === "tool",
    ).length;
    if (readCount < 2) {
      if (readCount === 0)
        assert.doesNotMatch(JSON.stringify(request), /PRIVATE_MEMBER_RESOURCE/);
      if (readCount === 1)
        assert.match(
          request.messages.at(-1).content,
          /\/skills\/specialist\/references\/guide.md/,
        );
      return {
        content: "",
        toolCalls: [
          {
            id: `member-read-${readCount}`,
            name: "read_file",
            arguments: {
              file_path: readCount
                ? "/skills/specialist/references/guide.md"
                : "/skills/specialist/SKILL.md",
            },
          },
        ],
        finishReason: "tool_calls",
      };
    }
    assert.match(request.messages.at(-1).content, /PRIVATE_MEMBER_RESOURCE/);
    return final("Member reference result");
  });
  const member = f.snapshot.agents.get(2);
  const guide = {
    ...member.skills.get("specialist"),
    versionId: 62,
    resourceId: 162,
    resources: [
      { path: "references/guide.md", content: "PRIVATE_MEMBER_RESOURCE" },
    ],
  };
  const composition = freeze({
    ...f.snapshot,
    agents: new Map(
      [...f.snapshot.agents].map(([id, agent]) => [
        id,
        id === 2
          ? { ...agent, skills: new Map([["specialist", guide]]) }
          : agent,
      ]),
    ),
  });
  const result = await f.service.run(composition, f.input);
  await f.tracer.flush();
  assert.equal(result.result.answer, "Consolidated reference answer");
  assert.equal(f.requests.length, 5);
  assert.equal(result.contextSnapshot.executionBudget.modelCalls, 5);
  assert.equal(result.contextSnapshot.executionBudget.toolCalls, 3);
  const reads = f.exported.filter(
    (span) =>
      span.name === "workspace_read_file" &&
      span.metadata.skillVersionId === 62,
  );
  assert.equal(reads.length, 2);
  assert.ok(reads.every((span) => span.metadata.skillId === "specialist"));
  assert.doesNotMatch(
    JSON.stringify(f.exported),
    /PRIVATE_MEMBER_RESOURCE|PRIVATE_ROOT|GUIDE_FOR_MEMBER|references\/guide.md/,
  );
});

test("native member file artifacts remain isolated and propagate only authenticated metadata to the root and shared collector", async () => {
  let rootRounds = 0;
  const f = fixture({}, async (request) => {
    const id = runtimeScope.getStore().version.id;
    if (id === 1) {
      assert.doesNotMatch(JSON.stringify(request), /PRIVATE_MEMBER_FILE_BODY/);
      if (++rootRounds === 1)
        return {
          content: "",
          toolCalls: [
            {
              id: "file-member",
              name: "task",
              arguments: {
                subagent_type: "member_one",
                description: "Create your own report",
              },
            },
          ],
          finishReason: "tool_calls",
        };
      const received = JSON.parse(
        request.messages.find((message) => message.role === "tool").content,
      );
      assert.equal(received.artifacts.length, 1);
      assert.equal(received.artifacts[0].kind, "execution_file");
      return {
        ...final("Member file is ready"),
        content: JSON.stringify({
          answer: "Member file is ready",
          artifactIds: [received.artifacts[0].id],
        }),
      };
    }
    assert.equal(id, 2);
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE_ROOT/);
    return request.messages.some((message) => message.role === "tool")
      ? {
          ...final("Member completed"),
          content: JSON.stringify({
            answer: "Member completed",
            filePaths: ["/workspace/outputs/member.md"],
          }),
        }
      : {
          content: "",
          toolCalls: [
            {
              id: "member-write",
              name: "write_file",
              arguments: {
                file_path: "/workspace/outputs/member.md",
                content: "PRIVATE_MEMBER_FILE_BODY",
              },
            },
          ],
          finishReason: "tool_calls",
        };
  });
  const composition = freeze({
    ...f.snapshot,
    agents: new Map(
      [...f.snapshot.agents].map(([id, agent]) => [
        id,
        { ...agent, spec: { ...agent.spec, fileOutputs: { enabled: true } } },
      ]),
    ),
  });
  const result = await f.service.run(composition, f.input);
  await f.tracer.flush();
  assert.equal(f.requests.length, 4);
  assert.equal(result.result.artifacts.length, 1);
  assert.equal(result.fileOutputs.length, 1);
  assert.equal(result.fileOutputs[0].producerVersionId, 2);
  assert.equal(result.fileOutputs[0].content, "PRIVATE_MEMBER_FILE_BODY");
  assert.doesNotMatch(
    JSON.stringify(result.contextSnapshot),
    /PRIVATE_MEMBER_FILE_BODY/,
  );
  assert.doesNotMatch(
    JSON.stringify(result.result),
    /PRIVATE_MEMBER_FILE_BODY|workspace/,
  );
  assert.doesNotMatch(
    JSON.stringify(f.exported),
    /PRIVATE_MEMBER_FILE_BODY|member.md|\/workspace\//,
  );
  assert.equal(result.contextSnapshot.executionBudget.modelCalls, 4);
});

test("model budget is shared across root/member/Skill and aborts before another actual request or retry", async () => {
  const f = fixture({ maxModelCalls: 2 });
  let context;
  await assert.rejects(
    f.service.run(f.snapshot, f.input, {
      onContext: (value) => {
        context = value;
      },
    }),
    (e) => e instanceof SharedExecutionBudgetError && e.limit === "model_calls",
  );
  assert.equal(f.requests.length, 2);
  assert.equal(context.executionBudget.modelCalls, 2);
  assert.equal(context.executionBudget.reservedTokens, 0);
  assert.equal(context.executionBudget.totalTokens, 10);
  await f.tracer.flush();
});

test("Chat adapter maps shared execution failures to HTTP while orchestration no longer has recursive taskRunner", async () => {
  const f = fixture({ maxModelCalls: 2 });
  const chat = new ChatOrchestratorService(f.service, f.llm, {
    snapshot: async () => f.snapshot,
  });
  assert.equal(chat.taskRunner, undefined);
  await assert.rejects(
    chat.askDetailed(
      "task",
      [],
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { compositionSnapshot: f.snapshot },
    ),
    (e) =>
      e.getStatus() === 502 && e.getResponse().code === "agent_budget_exceeded",
  );
  await f.tracer.flush();
});

test("shared tool cap counts actual retries but not deferred, cached, invalid or unauthorized calls", async () => {
  let calls = 0;
  const tool = {
    name: "read",
    description: "read",
    inputSchema: z.object({ q: z.string() }).strict(),
    execute: async () => {
      calls++;
      return {
        success: false,
        content: "temporary",
        errorCode: "tool_timeout",
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const execution = new ToolExecutionService(registry, new ToolPolicy());
  const budget = new SharedExecutionBudget({
    maxModelCalls: 10,
    maxToolCalls: 2,
  });
  const state = execution.createStateForAgent(["read"], 8);
  await withExecutionBudget(budget, async () => {
    execution.deferUntilReplanning("read", { q: "q" }, state);
    const invalid = await execution.execute(
      "read",
      {},
      { state: new Map(), permissions: [] },
      state,
    );
    assert.equal(invalid.result.errorCode, "invalid_arguments");
    const denied = await execution.execute(
      "outside",
      {},
      { state: new Map(), permissions: [] },
      state,
    );
    assert.equal(denied.result.errorCode, "tool_not_allowed");
    assert.equal(budget.counters.toolCalls, 0);
    const outcome = await execution.execute(
      "read",
      { q: "q" },
      { state: new Map(), permissions: [] },
      state,
      { retryDelaysMs: [0] },
    );
    assert.equal(outcome.result.errorCode, "shared_tool_budget_exceeded");
    assert.equal(outcome.trace.attempts, 2);
    registry.register({
      name: "get_product_detail",
      description: "detail",
      inputSchema: z.object({ productId: z.string() }),
        resultCacheKey: (input) => `detail:${input.productId}`,
      execute: async () => {
        throw Error("Cached data must not execute");
      },
    });
    const cachedState = execution.createStateForAgent(
      ["get_product_detail"],
      8,
    );
    cachedState.resultCache = new Map();
    cachedState.resultCache.set("detail:known", {
      success: true,
      content: "Cached authorized detail",
    });
    const cached = await execution.execute(
      "get_product_detail",
      { productId: "known" },
      { state: new Map(), permissions: [] },
      cachedState,
    );
    assert.equal(cached.trace.reused, true);
    assert.equal(budget.counters.toolCalls, 2);
  });
  assert.equal(calls, 2);
  assert.equal(budget.counters.toolCalls, 2);
});

test("native members enforce published continue/fail policies for exceptions and refusals, with no legacy task host", async () => {
  for (const policy of ["continue", "fail"])
    for (const refused of [true, false]) {
      const f = fixture({ failurePolicy: policy }, async (_request, round) => {
        if (runtimeScope.getStore().version.id === 2) {
          if (!refused) throw new ProviderAuthenticationError(401);
          return {
            content: JSON.stringify({
              answer: "Cannot verify the requested facts",
              status: "refused",
            }),
            toolCalls: [],
            finishReason: "stop",
          };
        }
        return round === 1
          ? {
              content: "",
              toolCalls: [
                {
                  id: "policy-member",
                  name: "task",
                  arguments: {
                    subagent_type: "member_one",
                    description: "Explicit member task",
                  },
                },
              ],
              finishReason: "tool_calls",
            }
          : final("Safe partial answer");
      });
      let context;
      const operation = f.service.run(f.snapshot, f.input, {
        onContext: (value) => {
          context = value;
        },
      });
      if (policy === "fail") {
        await assert.rejects(
          operation,
          (error) => error.code === "collaboration_failed",
        );
        assert.equal(f.requests.length, 2);
        assert.equal(context.specialistTasks[0].ok, false);
      } else {
        const result = await operation;
        assert.equal(result.result.answer, "Safe partial answer");
        assert.equal(f.requests.length, 3);
        assert.equal(result.contextSnapshot.specialistTasks[0].ok, false);
      }
      assert.equal(f.requests.filter((request) => request.id === 2).length, 1);
      await f.tracer.flush();
    }
});

test("unauthorized native member names fail before invocation, and members cannot recursively delegate even if old metadata suggests it", async () => {
  const f = fixture({}, async (request, round) =>
    round === 1
      ? {
          content: "",
          toolCalls: [
            {
              id: "outside",
              name: "task",
              arguments: {
                subagent_type: "outside",
                description: "Unapproved",
              },
            },
          ],
          finishReason: "tool_calls",
        }
      : (() => {
          assert.match(JSON.stringify(request.messages), /invalid_arguments/);
          return final("No unauthorized access");
        })(),
  );
  const result = await f.service.run(f.snapshot, f.input);
  assert.equal(result.result.answer, "No unauthorized access");
  assert.equal(result.contextSnapshot.specialistTasks.length, 0);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every((request) => request.id === 1));
  await f.tracer.flush();
  let memberRounds = 0;
  const recursive = fixture({}, async (request, round) => {
    if (runtimeScope.getStore().version.id === 2) {
      memberRounds++;
      assert.ok(
        !request.tools.some((tool) =>
          ["task", "delegate_agent", "run_skill"].includes(tool.name),
        ),
      );
      return memberRounds === 1
        ? {
            content: "",
            toolCalls: [
              {
                id: "bounce",
                name: "task",
                arguments: {
                  subagent_type: "entry",
                  description: "Unapproved recursive task",
                },
              },
            ],
            finishReason: "tool_calls",
          }
        : (() => {
            assert.match(JSON.stringify(request.messages), /tool_not_allowed/);
            return final("Member stopped recursion");
          })();
    }
    return round === 1
      ? {
          content: "",
          toolCalls: [
            {
              id: "allowed-member",
              name: "task",
              arguments: {
                subagent_type: "member_one",
                description: "Explicit authorized task",
              },
            },
          ],
          finishReason: "tool_calls",
        }
      : final("Root completed");
  });
  const stopped = await recursive.service.run(
    recursive.snapshot,
    recursive.input,
  );
  assert.equal(stopped.result.answer, "Root completed");
  assert.equal(recursive.requests.length, 4);
  assert.equal(stopped.contextSnapshot.specialistTasks.length, 1);
  assert.equal(stopped.contextSnapshot.executionBudget.toolCalls, 1);
  await recursive.tracer.flush();
});

test("parent cancellation reaches a currently running native member and prevents root finalization", async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({}, async (request) => {
    if (runtimeScope.getStore().version.id === 1)
      return {
        content: "",
        toolCalls: [
          {
            id: "waiting-member",
            name: "task",
            arguments: {
              subagent_type: "member_one",
              description: "Wait for authorized read",
            },
          },
        ],
        finishReason: "tool_calls",
      };
    entered();
    await new Promise((_, reject) =>
      request.signal.addEventListener(
        "abort",
        () => reject(request.signal.reason),
        { once: true },
      ),
    );
    assert.fail("Cancelled member must not complete");
  });
  const pending = f.service.run(f.snapshot, {
    ...f.input,
    signal: controller.signal,
  });
  await started;
  controller.abort(new Error("parent disconnected"));
  await assert.rejects(pending, /disconnected|abort/iu);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests.filter((request) => request.id === 1).length, 1);
  await f.tracer.flush();
});

test("authorized member references remain generic data at the Chat edge, never share member bodies/files or grant root product tools", async () => {
  const p = {
    id: "member-product-7",
    name: "Heater",
    brand: "Brand",
    categoryId: "heating",
    category: "Heating",
    summary: "Summary",
    description: "PRIVATE_MEMBER_PRODUCT_BODY",
    specifications: { power: "1500 W" },
  };
  let childRounds = 0;
  const f = fixture({}, async (request, round) => {
    const own = runtimeScope.getStore();
    if (own.version.id === 2) {
      childRounds++;
      return childRounds === 1
        ? {
            content: "",
            toolCalls: [
              { id: "own-product", name: "read_own_product", arguments: {} },
            ],
            finishReason: "tool_calls",
          }
        : {
            ...final("Confirmed member summary"),
            content: JSON.stringify({
              answer: "Confirmed member summary",
              referenceIds: [p.id],
            }),
          };
    }
    assert.ok(!request.tools.some((tool) => tool.name === "read_own_product"));
    assert.doesNotMatch(
      JSON.stringify(request.messages),
      /PRIVATE_MEMBER_PRODUCT_BODY/,
    );
    return round === 1
      ? {
          content: "",
          toolCalls: [
            {
              id: "product-member",
              name: "task",
              arguments: {
                subagent_type: "member_one",
                description: "Read your authorized product",
              },
            },
          ],
          finishReason: "tool_calls",
        }
      : (() => {
          assert.match(JSON.stringify(request.messages), /member-product-7/);
          return {
            ...final("Public answer"),
            content: JSON.stringify({
              answer: `Heater ${p.id} is 1500 W`,
              referenceIds: [p.id],
            }),
          };
        })();
  });
  const member = f.snapshot.agents.get(2);
  const productTool = {
    name: "read_own_product",
    description: "Own product read",
    inputSchema: z.object({}).strict(),
    execute: async () => ({
      success: true,
      content: JSON.stringify(p),
      data: p,
      references:[{kind:"record",id:p.id,title:p.name}],
    }),
  };
  const snapshot = {
    ...f.snapshot,
    agents: new Map(
      [...f.snapshot.agents].map(([id, agent]) => [
        id,
        id === 2
          ? { ...member, tools: new Map([["read_own_product", productTool]]) }
          : agent,
      ]),
    ),
  };
  const result = await f.service.run(snapshot, f.input);
  assert.equal(result.result.answer, `Heater ${p.id} is 1500 W`);
  assert.equal(result.output.references[0].id, p.id);
  assert.equal(
    result.contextSnapshot.toolCalls.some(
      (call) => call.name === "read_own_product",
    ),
    false,
  );
  assert.equal(f.requests.length, 4);
  assert.equal(result.totalTokens, 20);
  await f.tracer.flush();
  assert.doesNotMatch(
    JSON.stringify(f.exported),
    /PRIVATE_MEMBER_PRODUCT_BODY/,
  );
});

test("token reservations are concurrent-safe; unknown paid failures stay charged and pre-provider accounting rejection releases admission", async () => {
  const budget = new SharedExecutionBudget({
    maxModelCalls: 2,
    maxToolCalls: 2,
    maxTotalTokens: 3000,
  });
  const settle = budget.reserveModel(2000);
  assert.throws(() => budget.reserveModel(2000), SharedExecutionBudgetError);
  settle(null);
  settle(usage);
  assert.equal(budget.counters.totalTokens, 2000);
  assert.equal(budget.counters.reservedTokens, 0);
  const next = budget.reserveModel(500);
  next({ ...usage, totalTokens: 1 });
  assert.equal(
    budget.counters.totalTokens,
    2005,
    "inconsistent total cannot undercount known components",
  );
  const admission = new SharedExecutionBudget({
    maxModelCalls: 1,
    maxToolCalls: 1,
  });
  await withExecutionBudget(admission, () =>
    withModelCallAccounting(
      {
        reserve: async () => {
          throw Error("accounting denied");
        },
      },
      () =>
        assert.rejects(
          reserveModelCall({ model: "fixture", messages: [] }, "planner"),
          /accounting denied/,
        ),
    ),
  );
  assert.deepEqual(admission.counters, {
    modelCalls: 0,
    toolCalls: 0,
    totalTokens: 0,
    reservedTokens: 0,
  });
  let attempts = 0;
  const llm = new LlmService({
    model: "fixture",
    chat: async () => {
      attempts++;
      throw new ProviderUnavailableError();
    },
  });
  llm.logger.warn = () => {};
  await withExecutionBudget(admission, () =>
    assert.rejects(
      llm.completeDetailed("prompt", "task", "fixture", "planner", {
        retryDelaysMs: [0],
      }),
      SharedExecutionBudgetError,
    ),
  );
  assert.equal(attempts, 1);
  assert.ok(admission.counters.totalTokens > 0);
  assert.equal(admission.counters.reservedTokens, 0);
});

test('single Agent task-wide model budget stops a second native decision before provider execution',async()=>{
 const f=fixture({},async()=>({content:'',toolCalls:[{id:'inspect-workspace',name:'ls',arguments:{path:'/'}}],finishReason:'tool_calls'}));
 const snapshot=singleSnapshot(f),entry=snapshot.agents.get(1);
 entry.spec={...entry.spec,executionLimits:{maxModelCalls:1,maxToolCalls:4,maxTotalTokens:10000}};
 await assert.rejects(f.service.run(snapshot,f.input),e=>e.code==='agent_budget_exceeded'||e.errorCode==='agent_budget_exceeded'||e instanceof SharedExecutionBudgetError||e.getResponse?.()?.code==='agent_budget_exceeded');
 assert.equal(f.requests.length,1,'no hidden second provider request');
 await f.tracer.close();
});
