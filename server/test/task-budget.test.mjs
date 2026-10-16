import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { configuredExecutionBudget } from "../dist/ai/agent/execution-budget.js";
import {
  parseRunRequest,
  pinnedTaskInput,
} from "../dist/executions/run-request.js";
import { chatTask } from "../dist/chat/agent-chat-context.js";
import { agentExecutionLimitsSchema } from "../dist/agent-management/resource.types.js";

const runtime = { maxPlannerRounds: 12, maxToolCalls: 8 };
const limits = { maxModelCalls: 6, maxToolCalls: 25, maxTotalTokens: 60000 };
function composition(explicit = limits) {
  return {
    workspaceId: 1,
    agentId: 2,
    entryVersionId: 3,
    agents: new Map([
      [
        3,
        {
          version: { id: 3 },
          spec: {
            runtime,
            executionLimits: explicit,
            promptVersionId: 4,
          },
        },
      ],
    ]),
  };
}

test("task budgets are independent of collaboration; published legacy limits remain unchanged", () => {
  assert.deepEqual(agentExecutionLimitsSchema.parse({}), {
    maxModelCalls: 32,
    maxToolCalls: 40,
    maxTotalTokens: 120000,
  });
  const legacy = {
    maxDelegations: 3,
    maxModelCalls: 20,
    maxToolCalls: 30,
    maxTotalTokens: 90000,
  };
  assert.deepEqual(configuredExecutionBudget(runtime, legacy, limits), limits);
  assert.deepEqual(configuredExecutionBudget(runtime, legacy), {
    maxModelCalls: 20,
    maxToolCalls: 30,
    maxTotalTokens: 90000,
  });
  assert.deepEqual(configuredExecutionBudget(runtime), {
    maxModelCalls: 192,
    maxToolCalls: 32,
  });
  assert.deepEqual(configuredExecutionBudget(runtime, { maxDelegations: 3 }), {
    maxModelCalls: 32,
    maxToolCalls: 40,
    maxTotalTokens: 120000,
  });
});

test("Run pins the new published task budget and caller limits can only reduce it", () => {
  const input = (body) =>
    pinnedTaskInput(
      composition(),
      parseRunRequest({ task: "test", ...body }),
      "run",
      "trace",
    );
  const expected = { ...limits, maxDecisions: 12, maxDurationMs: 180000 };
  assert.deepEqual(input({}).limits, expected);
  assert.deepEqual(
    input({
      limits: {
        maxModelCalls: 100,
        maxToolCalls: 100,
        maxTotalTokens: 1000000,
      },
    }).limits,
    expected,
  );
  assert.deepEqual(
    input({
      limits: { maxModelCalls: 2, maxToolCalls: 0, maxTotalTokens: 1000 },
    }).limits,
    { ...expected, maxModelCalls: 2, maxToolCalls: 0, maxTotalTokens: 1000 },
  );
});

test("Chat uses the explicit task budget without confusing it with a single Agent native tool cap", () => {
  const input = { question: "test", recentHistory: [] };
  assert.deepEqual(chatTask(composition(), input).limits, {
    maxDecisions: 12,
    ...limits,
  });
  const legacy = composition();
  delete legacy.agents.get(3).spec.executionLimits;
  assert.deepEqual(chatTask(legacy, input).limits, {
    maxDecisions: 12,
    maxToolCalls: 8,
  });
});
