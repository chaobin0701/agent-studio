import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  WorkflowTestService,
  workflowContextFingerprint,
} from "../dist/executions/workflow-test.service.js";
import { SpecializedWorkflowRegistry } from "../dist/ai/workflows/specialized-workflow.js";
import { textSummary } from "../dist/ai/workflows/text-summary.js";
import { makeManagedTool } from "../dist/agent-management/managed-tool.js";
import { toolSchema } from "../dist/agent-management/resource.types.js";
import { PhoenixExecutionTracer } from "../dist/observability/execution-tracer.js";
import { executionContextView } from "../dist/observability/execution-view.js";
import { nativeChat } from "./helpers/native-chat.mjs";
const { Annotation, StateGraph, START, END } = createRequire(import.meta.url)(
  "@langchain/langgraph",
);

function fixture({
  definition = textSummary,
  tools = [],
  respond = () => ({ content: "Bounded summary" }),
  permissions = ["agent_config.manage", "agent_tools.execute"],
  approval = false,
} = {}) {
  const registry = new SpecializedWorkflowRegistry();
  registry.register(definition);
  const version = {
    id: 701,
    key: "draft_flow",
    resourceId: 700,
    kind: "tool",
    name: "Test flow",
    enabled: true,
    status: "draft",
    version: 1,
    revision: 2,
    config: toolSchema.parse({
      type: "builtin",
      target: definition.key,
      description: "Workflow",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      readOnly: true,
      requiresApproval: approval,
      maxRetries: 3,
      timeoutMs: 30000,
    }),
  };
  const tool = makeManagedTool(version, (key) =>
    registry.tools().find((t) => t.name === key),
  );
  const native = nativeChat({
    tools,
    respond,
    businessPrompt: "PRIVATE_AGENT_GUIDANCE",
  });
  const saved = [],
    calls = [],
    tested = [],
    reservations = [];
  const db = {
    platformQuery: async (sql) => ({
      rows: sql.includes("FROM workspaces")
        ? [{ id: 1, role: "custom", permission_codes: permissions }]
        : ["agent_config.manage", "agent_tools.execute"].map((code) => ({
            code,
          })),
    }),
    query: async (sql, args = []) => {
      if (sql.includes("v.config FROM agent_resource_versions"))
        return {
          rows: [
            {
              name: "Approved dependency",
              config: { requiresApproval: true, readOnly: false },
            },
          ],
        };
      if (sql.includes("INSERT INTO chat_traces"))
        saved.push(JSON.parse(args[3]));
      return { rows: [], rowCount: 1 };
    },
  };
  const management = {
    prepareToolTest: async () => ({
      version,
      signature: "fixed-draft-signature",
      tool,
    }),
    snapshot: async () => ({
      ...native.snapshot,
      createdAt: new Date().toISOString() + randomUUID(),
    }),
    assertTestToolAvailable: async () => {},
    recordToolTest: async (_actor, _version, _signature, result) =>
      tested.push(result),
  };
  const app = {
    id: randomUUID(),
    agentId: native.snapshot.agentId,
    enabled: true,
    scopes: ["chat:write"],
  };
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reservedTokens: 0,
    unknownModelCalls: 0,
    accounting: "actual",
    includesSummary: false,
  };
  let cached;
  const access = {
    app: async () => app,
    tokens: {
      accounting: () => ({
        reserve: async () => {
          reservations.push(1);
          return {
            settle: async (usage) => {
              totals.inputTokens += usage?.inputTokens ?? 0;
              totals.outputTokens += usage?.outputTokens ?? 0;
              totals.totalTokens += usage?.totalTokens ?? 0;
            },
          };
        },
      }),
      callUsage: async () => totals,
    },
    admitManagedTest: async (_app, _actor, _agent, fingerprint, key) => {
      const previous = calls.find((c) => c.key === key);
      if (previous) {
        assert.equal(previous.fingerprint, fingerprint);
        if (cached) return { cached };
        throw new Error("No replay of a failed admission");
      }
      calls.push({ fingerprint, key });
      return { cached: null, callId: randomUUID() };
    },
    finish: async (_run, result) => {
      cached = result ? { ...result, usage: { ...totals } } : undefined;
      return cached ?? null;
    },
  };
  const service = new WorkflowTestService(
    db,
    management,
    access,
    native.llm,
    native.gateway,
    new PhoenixExecutionTracer({ enabled: false }),
  );
  const body = {
    contextFingerprint: workflowContextFingerprint(
      { version, signature: "fixed-draft-signature", tool },
      native.snapshot,
    ),
    applicationId: app.id,
    agentVersionId: native.snapshot.entryVersionId,
    requestId: randomUUID(),
    input: { text: "PRIVATE_INPUT" },
    approved: approval,
    approvedToolVersionIds: [],
  };
  return {
    service,
    body,
    native,
    saved,
    calls,
    tested,
    reservations,
    version,
    management,
  };
}

test("contextual summary uses actual StateGraph, exactly one governed model call, stable replay and ordinary trace budget", async () => {
  const f = fixture();
  const result = await f.service.execute(1, 701, f.body);
  assert.equal(result.ok, true);
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(f.native.requests.length, 1);
  assert.equal(f.reservations.length, 1);
  assert.match(
    f.native.requests[0].messages[0].content,
    /PRIVATE_AGENT_GUIDANCE/,
  );
  assert.equal(f.native.requests[0].tools, undefined);
  assert.equal(JSON.parse(result.content).summary, "Bounded summary");
  const view = executionContextView(f.saved[0]);
  assert.equal(view.entryPoint, "workflow_test");
  assert.equal(view.budget.modelCalls, 1);
  assert.equal(view.budget.toolCalls, 1);
  assert.equal(view.specializedFlows[0].nodes, 2);
  assert.equal(view.specializedFlows[0].modelCalls, 1);
  assert.equal(JSON.stringify(view).includes("PRIVATE_INPUT"), false);
  assert.equal(JSON.stringify(view).includes("PRIVATE_AGENT_GUIDANCE"), false);
  assert.deepEqual(await f.service.execute(1, 701, f.body), result);
  assert.equal(f.native.requests.length, 1);
  assert.equal(f.tested.length, 1);
});

function dependencyFlow() {
  return {
    key: "flow_dependency_v1",
    version: "1",
    description: "Explicit dependency",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    allowedTools: ["write_dependency"],
    limits: {
      maxSteps: 1,
      maxModelCalls: 0,
      maxToolCalls: 1,
      maxDurationMs: 1000,
    },
    build: (effects) => {
      const State = Annotation.Root({ text: Annotation(), ok: Annotation() });
      return new StateGraph(State)
        .addNode("write", (state) =>
          effects.node("write", async () => ({
            ok: (await effects.tool("write_dependency", { text: state.text }))
              .success,
          })),
        )
        .addEdge(START, "write")
        .addEdge("write", END)
        .compile();
    },
  };
}
test("draft target gets no implicit dependencies; only published authorized versions with explicit approval execute", async () => {
  const definition = dependencyFlow();
  let writes = 0;
  const dependency = {
    name: "write_dependency",
    description: "Write",
    execution: { channel: "tools", source: "builtin", toolVersionId: 501 },
    inputSchema: z.object({ text: z.string() }),
    planning: { isIdempotent: false, canBatch: false },
    execute: async (_input, context) => {
      assert.deepEqual(context.permissions, ["write_dependency"]);
      assert.ok(context.approvedTools.includes("write_dependency"));
      writes++;
      return { success: true, content: "written" };
    },
  };
  const missing = fixture({ definition });
  await assert.rejects(
    missing.service.execute(1, 701, missing.body),
    /未授权流程依赖/,
  );
  const f = fixture({ definition, tools: [dependency] });
  await assert.rejects(f.service.execute(1, 701, f.body), /逐项确认/);
  await assert.rejects(
    f.service.execute(1, 701, { ...f.body, approvedToolVersionIds: [999] }),
    /只能批准/,
  );
  assert.equal(writes, 0);
  assert.equal(f.calls.length, 0);
  const result = await f.service.execute(1, 701, {
    ...f.body,
    approvedToolVersionIds: [501],
  });
  assert.equal(result.ok, true);
  assert.equal(writes, 1);
  assert.equal(f.native.requests.length, 0);
  assert.equal(f.saved[0].executionBudget.toolCalls, 2);
});
test("permissions, fixed Agent version and parameters are validated before admission/effects", async () => {
  const unauthorized = fixture({ permissions: ["agent_config.manage"] });
  await assert.rejects(
    unauthorized.service.execute(1, 701, unauthorized.body),
    /工具执行权限/,
  );
  const f = fixture();
  await assert.rejects(
    f.service.execute(1, 701, { ...f.body, agentVersionId: 999 }),
    /生效版本已更改/,
  );
  await assert.rejects(
    f.service.execute(1, 701, { ...f.body, input: { text: 100 } }),
    /Schema/,
  );
  await assert.rejects(
    f.service.execute(1, 701, {
      ...f.body,
      contextFingerprint: "0".repeat(64),
    }),
    /实际模型配置已更改/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.native.requests.length, 0);
});
test("invalid workflow output fails closed, marks draft failed and cannot automatically replay a partial execution", async () => {
  const f = fixture({ respond: () => ({ content: "x".repeat(4001) }) });
  const result = await f.service.execute(1, 701, f.body);
  assert.equal(result.ok, false);
  assert.equal(f.native.requests.length, 1);
  assert.equal(f.tested[0].ok, false);
  assert.equal(f.saved[0].specializedFlows[0].ok, false);
  assert.equal(f.saved[0].executionBudget.modelCalls, 1);
  await assert.rejects(f.service.execute(1, 701, f.body), /No replay/);
  assert.equal(f.native.requests.length, 1);
});
