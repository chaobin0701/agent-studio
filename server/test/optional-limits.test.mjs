import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationLimit,
  DISABLED_APPLICATION_LIMITS,
} from "../dist/integrations/application-limits.js";
import { IntegrationService } from "../dist/integrations/integration.service.js";
import { IntegrationTokenService } from "../dist/integrations/integration-token.service.js";
import {
  configuredExecutionBudget,
  PLATFORM_EXECUTION_LIMITS,
} from "../dist/ai/agent/execution-budget.js";
import { chatTask } from "../dist/chat/agent-chat-context.js";
import {
  parseRunRequest,
  pinnedTaskInput,
} from "../dist/executions/run-request.js";

const app = {
  id: "app",
  agentId: 4,
  enabled: true,
  websiteEnabled: true,
  apiEnabled: true,
  authVersion: 1,
  scopes: ["chat:write", "conversations:read"],
  requestsPerMinute: 2,
  concurrency: 1,
  dailyRequests: 3,
  dailyTokenLimit: 10,
};
const usage = {
  minute: 20,
  daily: 20,
  active: 3,
  visitorMinute: 0,
  keyMinute: 0,
};
const today = {
  totalTokens: 100,
  reservedTokens: 50,
  resetAt: new Date(Date.now() + 60000).toISOString(),
};
function fixture(settings, counterOverrides = {}) {
  const current = { ...app, ...settings };
  let admitted = 0;
  const counters = { ...usage, ...counterOverrides };
  const query = async (sql) => {
    if (sql.includes("FROM integration_apps"))
      return { rows: [current], rowCount: 1 };
    if (sql.includes("AS minute")) return { rows: [counters], rowCount: 1 };
    if (sql.includes("INSERT INTO integration_calls")) admitted++;
    return { rows: [], rowCount: 0 };
  };
  const service = new IntegrationService(
    { query, transaction: async (work) => work({ query }) },
    {},
    {},
    { daily: async () => today },
  );
  return {
    service,
    current,
    identity: {
      kind: "website",
      app: current,
      scopes: current.scopes,
      ownerId: "owner",
    },
    admitted: () => admitted,
  };
}

test("missing switches preserve legacy limits; disabled switches preserve values but do not enforce them", () => {
  assert.equal(applicationLimit(app, "dailyRequests"), 3);
  const disabled = {
    ...app,
    limitSettings: { ...DISABLED_APPLICATION_LIMITS },
  };
  for (const key of Object.keys(DISABLED_APPLICATION_LIMITS))
    assert.equal(applicationLimit(disabled, key), null);
  assert.equal(disabled.dailyRequests, 3);
  assert.equal(
    applicationLimit(
      {
        ...disabled,
        limitSettings: { ...disabled.limitSettings, dailyRequests: true },
      },
      "dailyRequests",
    ),
    3,
  );
});

test("actual request admission and status ignore disabled business quotas, not just the UI", async () => {
  const f = fixture({ limitSettings: { ...DISABLED_APPLICATION_LIMITS } });
  assert.equal((await f.service.publicStatus(f.identity)).canSend, true);
  await f.service.admitInvocation(
    f.identity,
    "owner",
    undefined,
    "task",
    "request",
    undefined,
    "run-fingerprint",
  );
  assert.equal(f.admitted(), 1);
  const legacy = fixture({});
  assert.equal(
    (await legacy.service.publicStatus(legacy.identity)).code,
    "daily_request_quota_exceeded",
  );
  await assert.rejects(
    legacy.service.admitInvocation(
      legacy.identity,
      "owner",
      undefined,
      "task",
      "request",
      undefined,
      "run-fingerprint",
    ),
    (error) => error.getStatus() === 429,
  );
  assert.equal(legacy.admitted(), 0);
});

test("each application limit can be re-enabled independently", async () => {
  for (const [key, code] of [
    ["dailyRequests", "daily_request_quota_exceeded"],
    ["dailyTokenLimit", "daily_token_quota_exceeded"],
    ["concurrency", "concurrency_limit"],
    ["requestsPerMinute", "request_rate_limit"],
  ]) {
    const f = fixture({
      limitSettings: { ...DISABLED_APPLICATION_LIMITS, [key]: true },
    });
    assert.equal((await f.service.publicStatus(f.identity)).code, code);
    await assert.rejects(
      f.service.admitInvocation(
        f.identity,
        "owner",
        undefined,
        "task",
        "request",
        undefined,
        "fingerprint",
      ),
      (error) => error.getResponse().code === code,
    );
  }
});
test("disabling business quotas retains platform protection and identifies it rather than claiming the business limit is enabled", async () => {
  const f = fixture(
    { limitSettings: { ...DISABLED_APPLICATION_LIMITS } },
    { active: 100 },
  );
  const status = await f.service.publicStatus(f.identity);
  assert.equal(status.code, "concurrency_limit");
  assert.equal(status.limitSource, "platform");
  await assert.rejects(
    f.service.admitInvocation(
      f.identity,
      "owner",
      undefined,
      "task",
      "request",
      undefined,
      "fingerprint",
    ),
    (error) => error.getResponse().message.includes("平台安全上限"),
  );
});

test("model reservation still meters actual calls after disabling the daily token budget", async () => {
  for (const enabled of [false, true]) {
    let inserts = 0;
    const query = async (sql) => {
      if (sql.startsWith("SELECT enabled"))
        return {
          rows: [
            {
              enabled: true,
              dailyTokenLimit: "10",
              limitSettings: { dailyTokenLimit: enabled },
            },
          ],
          rowCount: 1,
        };
      if (sql.startsWith("SELECT id FROM integration_calls"))
        return { rows: [{ id: "call" }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO integration_model_calls")) inserts++;
      return { rows: [], rowCount: 0 };
    };
    const tokens = new IntegrationTokenService({
      transaction: async (action) => action({ query }),
    });
    tokens.daily = async () => today;
    const reserve = () =>
      tokens
        .accounting("app", "call")
        .reserve(
          {
            model: "model",
            messages: [{ role: "user", content: "question" }],
            maxTokens: 100,
          },
          "answer",
        );
    if (enabled)
      await assert.rejects(reserve(), (error) => error.getStatus() === 429);
    else await reserve();
    assert.equal(inserts, enabled ? 0 : 1);
  }
});

test("disabled Agent budgets use explicit platform safety guards in both Chat and Run; callers can only reduce them", () => {
  const runtime = { maxPlannerRounds: 12, maxToolCalls: 8 };
  const executionLimits = {
    maxModelCalls: 3,
    maxToolCalls: 4,
    maxTotalTokens: 1000,
    enabled: {
      maxModelCalls: false,
      maxToolCalls: false,
      maxTotalTokens: false,
    },
  };
  assert.deepEqual(
    configuredExecutionBudget(runtime, undefined, executionLimits),
    PLATFORM_EXECUTION_LIMITS,
  );
  const composition = {
    workspaceId: 1,
    agentId: 1,
    entryVersionId: 2,
    agents: new Map([
      [
        2,
        {
          version: { id: 2 },
          spec: { runtime, executionLimits, promptVersionId: 3 },
        },
      ],
    ]),
  };
  assert.deepEqual(
    chatTask(composition, { question: "test", recentHistory: [] }).limits,
    { maxDecisions: 100, ...PLATFORM_EXECUTION_LIMITS },
  );
  const request = parseRunRequest({
    task: "test",
    limits: { maxToolCalls: 1, maxModelCalls: 2, maxTotalTokens: 500 },
  });
  assert.deepEqual(
    pinnedTaskInput(composition, request, "run", "trace").limits,
    {
      maxDecisions: 100,
      maxDurationMs: 180000,
      maxToolCalls: 1,
      maxModelCalls: 2,
      maxTotalTokens: 500,
    },
  );
  assert.equal(executionLimits.maxTotalTokens, 1000);
});
