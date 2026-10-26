import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, measureModelContext } from "../dist/chat/context-governor.js";
import { IntegrationService } from "../dist/integrations/integration.service.js";
import { IntegrationChatGateway } from "../dist/chat/integration-chat.gateway.js";

test("public chat result preserves context measurement for streaming and omits private execution data", () => {
  const gateway = Object.create(IntegrationChatGateway.prototype);
  const contextUsage = measureModelContext({ model: "demo-model", messages: [{ role: "user", content: "question" }] }, 32_000, 430);
  const result = gateway.publicResult({
    conversationId: "conversation-id", status: "completed", answer: "answer",
    structured: { suggestedFollowUps: ["next question"] }, contextUsage,
    toolSteps: [{ secret: "internal arguments" }],
  });
  assert.deepEqual(result.contextUsage, contextUsage);
  assert.deepEqual(result.structured, { suggestedFollowUps: ["next question"] });
  assert.equal("toolSteps" in result, false);
  assert.equal("contextUsage" in gateway.publicResult({ answer: "legacy" }), false);
});

test("context usage measures one actual request against its effective input budget", () => {
  const request = {
    model: "demo-model",
    maxTokens: 2000,
    messages: [{ role: "system", content: "s".repeat(600) }, { role: "user", content: "question" }],
    tools: [{ name: "lookup", description: "Lookup reference data", parameters: { type: "object" } }],
    responseFormat: { type: "json_object" },
  };
  const estimated = measureModelContext(request, 10_000, null);
  assert.equal(estimated.measurementSource, "heuristic");
  assert.equal(estimated.inputBudgetTokens, 6_976);
  assert.ok(estimated.estimatedInputTokens > estimateTokens("question"));
  assert.equal(estimated.includesDraft, false);

  const measured = measureModelContext(request, 10_000, 430);
  assert.equal(measured.measurementSource, "provider");
  assert.equal(measured.estimatedInputTokens, 430);
  assert.equal(measured.usagePercent, 6.2);
});

test("context projection never serializes image bytes or adds model-call usage", () => {
  const result = measureModelContext({
    model: "vision-model",
    messages: [{ role: "user", content: "inspect" }],
    images: [{ id: "image-id", mimeType: "image/jpeg", data: Buffer.from("PRIVATE IMAGE BYTES"), width: 1024, height: 512 }],
  }, 32_000, null);
  assert.equal(result.includesDraft, false);
  assert.equal(JSON.stringify(result).includes("PRIVATE IMAGE BYTES"), false);
  assert.ok(result.estimatedInputTokens >= 425);
  const chinese = measureModelContext({ model: "m", messages: [{ role: "user", content: "这是一段中文提示词" }] }, 32_000, null);
  assert.ok(chinese.estimatedInputTokens >= 10);
});

function quotaService({ app, usage = { startAt: "2026-10-20T00:00:00.000Z", resetAt: "2026-10-21T00:00:00.000Z", timezone: "Asia/Shanghai", totalTokens: 300, reservedTokens: 100, unknownModelCalls: 0 }, requests = 4 } = {}) {
  const service = Object.create(IntegrationService.prototype);
  service.app = async () => app;
  service.appValue = app;
  service.checkInspectionRate = () => {};
  service.tokens = { daily: async () => usage };
  service.db = { query: async () => ({ rows: [{ used: requests }] }) };
  return service;
}
const application = (overrides = {}) => ({
  id: "app-id", enabled: true, apiEnabled: true, websiteEnabled: true,
  scopes: ["chat:write", "conversations:read", "usage:read"],
  dailyRequests: 20, dailyTokenLimit: 1000,
  limitSettings: { requestsPerMinute: false, concurrency: false, dailyRequests: true, dailyTokenLimit: true },
  ...overrides,
});
const apiIdentity = (app, scopes = app.scopes) => ({ app, kind: "api", scopes });

test("display quota needs no usage scope and disabled limits are omitted", async () => {
  for (const app of [application({ dailyRequests: null, dailyTokenLimit: null }), application({ limitSettings: { requestsPerMinute:false, dailyRequests:false, dailyTokenLimit:false } })]) {
    const service = quotaService({ app });
    const { quota } = await service.displayQuota(apiIdentity(app, ["chat:write"]));
    assert.equal(quota.scope, "application-shared");
    for (const field of ["requests", "tokens", "minute"]) assert.equal(field in quota, false);
  }
  const service = quotaService({ app: application() });
  const { quota } = await service.displayQuota(apiIdentity(service.appValue, ["chat:write"]));
  assert.equal(quota.requests.used, 4);
  const website = await service.displayQuota({ app: service.appValue, kind: "website", ownerId: "visitor-id", scopes: ["conversations:read"] });
  assert.equal(website.quota.requests.used, 4);
  const disabled = quotaService({ app: application({ enabled:false }) });
  assert.deepEqual(await disabled.displayQuota(apiIdentity(disabled.appValue)), {quota:null});
});

test("minute-only shared quota uses the same rolling sixty-second application window", async () => {
  const service = quotaService({ app: application({requestsPerMinute:10,limitSettings:{dailyRequests:false,dailyTokenLimit:false,requestsPerMinute:true}}) });
  service.db = { query: async (sql, values) => {
    assert.match(sql, /created_at>now\(\)-interval '60 seconds'/);
    assert.deepEqual(values, ['app-id']);
    return {rows:[{used:10,retryAt:'2026-10-26T10:00:00Z'}]};
  }};
  const { quota } = await service.displayQuota(apiIdentity(service.appValue, []));
  assert.deepEqual(quota.minute, {limit:10,used:10,remaining:0,windowSeconds:60,retryAt:'2026-10-26T10:00:00.000Z'});
  assert.equal('requests' in quota, false);
});

test("display quota exposes only application-shared enabled limits and subtracts reservations", async () => {
  const service = quotaService({ app: application() });
  const result = await service.displayQuota(apiIdentity(service.appValue));
  assert.deepEqual(result, {
    quota: {
      scope: "application-shared",
      resetAt: "2026-10-21T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      checkedAt: result.quota.checkedAt,
      requests: { limit: 20, used: 4, remaining: 16 },
      tokens: { limit: 1000, used: 300, reserved: 100, remaining: 600, unsettled: true },
    },
  });
});
