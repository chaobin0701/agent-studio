import { TestExecutionTracer } from "./helpers/trace-collector.mjs";
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { z } from "zod";
import { Module, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { NestFactory } from "@nestjs/core";
import { DatabaseService } from "../dist/database.service.js";
import { AppConfigService } from "../dist/config/config.service.js";
import { DEFAULT_AGENT_CONFIGURATION } from "../dist/config/agent-config.js";
import { inWorkspace } from "../dist/workspaces/workspace-context.js";
import { AgentManagementService } from "../dist/agent-management/agent-management.service.js";
import { agentSchema, toolSchema } from "../dist/agent-management/resource.types.js";
import { ToolRegistry } from "../dist/ai/tools/tool-registry.js";
import { ToolExecutionService } from "../dist/ai/tools/tool-execution.js";
import { ToolPolicy } from "../dist/ai/tools/tool-policy.js";
import { AskUserTool } from "../dist/ai/tools/ask-user.tool.js";
import { SkillRegistry } from "../dist/ai/skills/skill-registry.js";
import { LlmService } from "../dist/chat/llm.service.js";
import { DeepAgentExecutionService } from "../dist/ai/deep-agents/deep-agent-execution.service.js";
import { AgentExecutionService } from "../dist/ai/runtime/agent-execution.service.js";
import { InteractionService } from "../dist/interactions/interaction.service.js";
import { IntegrationService, credentialHash } from "../dist/integrations/integration.service.js";
import { AgentAccessGuard } from "../dist/integrations/integration.guards.js";
import { AgentRunService } from "../dist/executions/agent-run.service.js";
import { AgentRunController } from "../dist/executions/agent-run.controller.js";
import { ExecutionArtifactService } from "../dist/artifacts/execution-artifact.service.js";
import { ChatService } from "../dist/chat/chat.service.js";
import { ChatOrchestratorService } from "../dist/chat/chat-orchestrator.service.js";
import { ConversationService } from "../dist/chat/conversation.service.js";
import { ChatApplicationService } from "../dist/chat/chat-application.service.js";
import { IntegrationChatGateway } from "../dist/chat/integration-chat.gateway.js";
import { AgentApiController } from "../dist/chat/agent-api.controller.js";
import { ChatRateLimitService } from "../dist/chat/chat-rate-limit.service.js";
import { InMemoryMessageBus } from "../dist/message-bus/in-memory-message-bus.js";
import { SecurityRateLimitService } from "../dist/security/security-rate-limit.service.js";
import { RequestContextMiddleware } from "../dist/security/request-context.middleware.js";
import { HttpExceptionFilter } from "../dist/security/http-exception.filter.js";

// Uses only the explicitly supplied disposable database. The actual controllers,
// admission/accounting, published-resource resolver and native Deep Agents run;
// only model responses and external write tools are deterministic local fixtures.
test("HTTP human interactions persist and resume actual Run/legacy execution without replaying model calls or writes", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60000,
}, async (t) => inWorkspace(1, async () => {
  const schema = `interaction_http_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  const tracer = new TestExecutionTracer({ enabled: false, project: "interaction-http-fixture" });
  let db, app;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(process.env.TEST_DATABASE_URL);
    connection.searchParams.set("options", `-csearch_path=${schema},public`);
    db = new DatabaseService({ databaseUrl: connection.toString() });
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort())
      await db.platformQuery((await readFile(new URL(name, dir), "utf8")).split("-- Down Migration")[0]);
    const promptId = (await db.query("WITH p AS(INSERT INTO prompt_resources(prompt_key,name,prompt_type)VALUES('hil.prompt','Interaction fixture','system')RETURNING id)INSERT INTO prompt_versions(resource_id,version,status,template)SELECT id,1,'published','Complete the authorized task. Ask for missing information and use only authorized tools.'FROM p RETURNING id::int")).rows[0].id;
    const modelId = (await db.query("WITH p AS(INSERT INTO model_plans(kind,name)VALUES('llm','Deterministic interaction fixture')RETURNING id)INSERT INTO model_plan_versions(plan_id,version,status,config)SELECT id,1,'published','{\"deployments\":[]}'FROM p RETURNING id::int")).rows[0].id;
    const resource = async (kind, key, value) => {
      const id = (await db.query("INSERT INTO agent_resources(kind,resource_key,name)VALUES($1,$2,$2)RETURNING id::int", [kind, key])).rows[0].id;
      const versionId = (await db.query("INSERT INTO agent_resource_versions(resource_id,version,status,config)VALUES($1,1,'published',$2)RETURNING id::int", [id, JSON.stringify(value)])).rows[0].id;
      if (kind === "agent") await db.query("UPDATE agent_resources SET current_version_id=$2 WHERE id=$1", [id, versionId]);
      return { id, versionId };
    };
    const tools = new ToolRegistry();
    for (const name of ["search_knowledge", "load_skill"])
      tools.register({ name, description: name, inputSchema: z.object({}), execute: async () => ({ success: true, content: "No configured resources" }) });
    const effects = { draft: 0, protected: 0 };
    const writeSchema = z.object({ value: z.number() }).strict();
    const writes = [
      { name: "record_draft", approval: false, effect: "draft" },
      { name: "submit_record", approval: true, effect: "protected" },
    ];
    const toolVersionIds = [];
    for (const write of writes) {
      const parameters = z.toJSONSchema(writeSchema);
      tools.register({ name: write.name, description: write.name, inputSchema: writeSchema, parameters,
        planning: { canBatch: false, isIdempotent: false },
        execute: async () => { effects[write.effect]++; return { success: true, content: "Recorded by isolated fixture" }; } });
      toolVersionIds.push((await resource("tool", write.name, toolSchema.parse({ type: "builtin", target: write.name,
        description: write.name, parameters, readOnly: false, requiresApproval: write.approval, maxRetries: 0, timeoutMs: 1000 }))).versionId);
    }
    const questionTool = new AskUserTool();
    tools.register(questionTool);
    toolVersionIds.push((await resource("tool", questionTool.name, toolSchema.parse({ type: "builtin", target: questionTool.name,
      description: questionTool.description, parameters: questionTool.parameters, readOnly: true, requiresApproval: false, maxRetries: 0, timeoutMs: 1000 }))).versionId);
    const agent = await resource("agent", "interaction_agent", agentSchema.parse({ responsibility: "General interaction fixture",
      promptVersionId: promptId, modelPlanVersionId: modelId, toolVersionIds, skillVersionIds: [], knowledgeBaseIds: [], runtime: {} }));
    const config = { agent: DEFAULT_AGENT_CONFIGURATION, jwt: { issuer: "hil-http-fixture", audience: "hil-http-admin" },
      security: { allowedOrigins: [], chatConcurrency: 5 } };
    const access = new IntegrationService(db, new JwtService({ secret: "isolated-http-interaction-fixture-only" }), config);
    const management = new AgentManagementService(db, config, tools, new SkillRegistry(), { snapshot: async () => ({ environment: "dev", prompts: {} }) }, {});
    const plans = new AsyncLocalStorage(), phases = new Map(), requests = [], gates = new Map();
    const provider = {
      model: "hil-http-fixture", contextWindowTokens: 32000, maxOutputTokens: 500,
      withPlan: (task) => task(), withPlanVersion: (plan, task) => plans.run(plan, task),
      planMetadata: () => ({ versionId: plans.getStore()?.id, planId: modelId, version: 1 }),
      attemptPlan: () => [{ provider, versionId: plans.getStore()?.id, deploymentId: 99, deploymentAttempt: 1, maxRetries: 0 }],
      async chat(request) {
        const text = JSON.stringify(request.messages);
        const flow = /HIL_(RUN|LEGACY|CANCEL)_FLOW/u.exec(text)?.[0];
        assert.ok(flow, "Every model call belongs to an explicitly named local fixture flow");
        const phase = (phases.get(flow) ?? 0) + 1;
        phases.set(flow, phase);
        requests.push({ flow, phase, messages: structuredClone(request.messages) });
        assert.ok(phase <= 4, "Resume must never replay earlier model steps");
        const gate = gates.get(flow);
        if (phase === 3 && gate) { gate.enter(); await gate.released; }
        const toolCalls = phase === 1 ? [{ id: `draft-${flow}`, name: "record_draft", arguments: { value: 1 } }]
          : phase === 2 ? [{ id: `question-${flow}`, name: "ask_user", arguments: { question: "预算是多少？", options: [{ id: "mid", label: "2000–3000 元" }], allowCustom: true } }]
            : phase === 3 ? [{ id: `submit-${flow}`, name: "submit_record", arguments: { value: 2500 } }] : [];
        if (phase >= 3) assert.match(text, /2000–3000 元/u, "Server normalizes the selected option into its original label");
        return { content: phase === 4 ? "已完成授权任务" : "", toolCalls, model: "hil-http-fixture",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, finishReason: toolCalls.length ? "tool_calls" : "stop" };
      },
      async *stream(request) {
        const result = await provider.chat(request);
        if (result.content) yield { type: "text_delta", delta: result.content };
        for (const [index, call] of result.toolCalls.entries()) yield { type: "tool_call_delta", index, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) };
        yield { type: "completed", usage: result.usage, finishReason: result.finishReason };
      },
    };
    const llm = new LlmService(provider), interactions = new InteractionService(db);
    const execution = new AgentExecutionService(new DeepAgentExecutionService(llm, new ToolExecutionService(tools, new ToolPolicy()), tracer));
    const artifacts = new ExecutionArtifactService(db, access);
    const runs = new AgentRunService(db, management, execution, access, tracer, artifacts, interactions);
    const chat = new ChatService(new ChatOrchestratorService(execution, llm, management), llm);
    const conversations = new ConversationService(db, chat, llm, undefined, config, undefined, access, undefined, management, tracer, artifacts, interactions);
    const bus = new InMemoryMessageBus(), events = [];
    for (const type of ["message.completed", "run.failed"]) bus.subscribe(type, (event) => events.push(event));
    const gateway = new IntegrationChatGateway(access, new ChatApplicationService(conversations, bus), db, management, interactions);
    class Fixture {}
    Module({ controllers: [AgentRunController, AgentApiController], providers: [AgentAccessGuard, SecurityRateLimitService,
      { provide: AppConfigService, useValue: config }, { provide: IntegrationService, useValue: access },
      { provide: AgentRunService, useValue: runs }, { provide: ConversationService, useValue: conversations },
      { provide: IntegrationChatGateway, useValue: gateway },
      { provide: ChatRateLimitService, useValue: new ChatRateLimitService(new SecurityRateLimitService(config), config) },
    ] })(Fixture);
    app = await NestFactory.create(Fixture, { logger: false });
    const middleware = new RequestContextMiddleware();
    app.use((request, response, next) => middleware.use(request, response, next));
    app.setGlobalPrefix("api");
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    const failures = [], filter = new HttpExceptionFilter();
    app.useGlobalFilters({ catch(error, host) { failures.push(error); return filter.catch(error, host); } });
    await app.listen(0, "127.0.0.1");
    const appId = randomUUID(), token = `ag_live_${randomUUID().replaceAll("-", "")}`;
    await db.query("INSERT INTO integration_apps(id,name,enabled,api_enabled,website_enabled,agent_id,requests_per_minute,concurrency,daily_requests,scopes) VALUES($1,'Isolated interaction HTTP fixture',true,true,true,$2,1000,10,1000,$3)", [appId, agent.id, ["chat:write", "conversations:read", "usage:read"]]);
    await db.query("INSERT INTO integration_api_keys(id,app_id,name,secret_hash,masked_key,scopes) VALUES($1,$2,'Fixture',$3,'fixture',$4)", [randomUUID(), appId, credentialHash(token), ["chat:write", "conversations:read", "usage:read"]]);
    const base = `${await app.getUrl()}/api/v1/agent`;
    const send = async (path, body, { key, status = 200, method = body ? "POST" : "GET" } = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json();
      const detail = response.status >= 500 ? failures.map((error) => error.stack).join("\n") : "";
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}\n${detail}`);
      return value;
    };
    const answer = (card) => ({ kind: "question", interactionId: card.id, revision: card.revision, optionId: "mid" });
    const approve = (card) => ({ kind: "approval", interactionId: card.id, revision: card.revision, decision: "approve" });

    await t.test("Run: question and exact tool approval resume one ledger; duplicate replies and other owners cannot replay writes", async () => {
      const first = await send(`/${agent.id}/runs`, { task: "HIL_RUN_FLOW", userId: "customer-one", stream: false }, { key: "run-human-flow", status: 202 });
      assert.equal(first.status, "waiting");
      assert.equal(first.interaction.kind, "question");
      const originalTrace = (await db.query("SELECT trace_id FROM integration_calls WHERE id=$1", [first.runId])).rows[0].trace_id;
      assert.deepEqual(effects, { draft: 1, protected: 0 });
      assert.equal(phases.get("HIL_RUN_FLOW"), 2);
      const path = `/${agent.id}/runs/${first.runId}`;
      const detail = await send(`${path}?userId=customer-one`);
      assert.equal(detail.status, "waiting");
      assert.equal(detail.interactions[0].status, "pending");
      await send(`${path}?userId=other-customer`, undefined, { status: 404 });
      await send(`${path}/interactions/${first.interaction.id}/respond?userId=other-customer`, answer(first.interaction), { status: 404 });
      const second = await send(`${path}/interactions/${first.interaction.id}/respond?userId=customer-one`, answer(first.interaction), { status: 202 });
      assert.equal(second.interaction.kind, "approval");
      assert.equal(second.interaction.toolName, "submit_record");
      assert.deepEqual(second.interaction.arguments, { value: 2500 });
      assert.deepEqual(effects, { draft: 1, protected: 0 });
      assert.equal(phases.get("HIL_RUN_FLOW"), 3);
      const replay = await send(`${path}/interactions/${first.interaction.id}/respond?userId=customer-one`, answer(first.interaction), { status: 202 });
      assert.equal(replay.replayed, true);
      assert.equal(phases.get("HIL_RUN_FLOW"), 3);
      await send(`${path}/interactions/${second.interaction.id}/respond?userId=other-customer`, approve(second.interaction), { status: 404 });
      const completed = await send(`${path}/interactions/${second.interaction.id}/respond?userId=customer-one`, approve(second.interaction));
      assert.equal(completed.runId, first.runId);
      assert.match(completed.answer, /已完成/u);
      assert.deepEqual(effects, { draft: 1, protected: 1 });
      assert.equal(phases.get("HIL_RUN_FLOW"), 4);
      const final = await send(`${path}?userId=customer-one`);
      assert.equal(final.status, "completed");
      assert.deepEqual(final.interactions.map((card) => card.status), ["answered", "approved"]);
      const accounting = (await db.query("SELECT total_tokens::int,status,trace_id FROM integration_calls WHERE id=$1", [first.runId])).rows[0];
      assert.equal(accounting.status, "completed");
      assert.equal(accounting.total_tokens, 20);
      assert.equal(accounting.trace_id, originalTrace, "All resumes reuse the original trace");
      assert.equal((await db.query("SELECT * FROM integration_model_calls WHERE call_id=$1", [first.runId])).rowCount, 4);
      assert.equal((await db.query("SELECT id FROM conversations")).rowCount, 0, "Stateless Run creates no implicit conversations");
      assert.equal((await db.query("SELECT * FROM agent_native_checkpoints WHERE run_id=$1", [first.runId])).rowCount, 0);
      assert.equal((await db.query("SELECT * FROM agent_native_checkpoint_writes WHERE run_id=$1", [first.runId])).rowCount, 0);
    });

    await t.test("legacy Chat: cancelling an answered old card returns 409 while current approval still completes; all cards survive in history", async () => {
      const first = await send(`/${agent.id}/messages`, { message: "HIL_LEGACY_FLOW", userId: "customer-one", stream: false }, { key: "legacy-human-flow", status: 202 });
      const path = `/conversations/${first.conversationId}`;
      const responsePath = (card) => `${path}/interactions/${card.id}/respond?userId=customer-one&stream=false`;
      assert.equal(first.interaction.kind, "question");
      assert.deepEqual(await send(`${path}/messages?userId=customer-one`), [], "Waiting is not a completed assistant message");
      const pending = await send(`${path}/runs?userId=customer-one`);
      assert.equal(pending[0].status, "waiting");
      assert.equal(pending[0].integrationCallId, first.runId);
      const originalRunId = pending[0].id;
      let entered, release;
      const atResume = new Promise((resolve) => { entered = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      gates.set("HIL_LEGACY_FLOW", { enter: entered, released });
      const responding = send(responsePath(first.interaction), answer(first.interaction), { status: 202 });
      // A second browser tab still has the old question card while the winning
      // reply is actively resuming. Its cancel must not erase that native run.
      try {
        await Promise.race([atResume, responding.then(() => assert.fail("Resume must reach the controlled model step"))]);
        await send(`${path}/interactions/${first.interaction.id}/cancel?userId=customer-one`, {}, { status: 409 });
      } finally { release(); }
      const second = await responding;
      assert.equal(second.interaction.kind, "approval");
      await send(`${path}/interactions/${first.interaction.id}/cancel?userId=customer-one`, {}, { status: 409 });
      const stillWaiting = await send(`${path}/runs?userId=customer-one`);
      assert.equal(stillWaiting[0].id, originalRunId);
      assert.equal(stillWaiting[0].status, "waiting");
      assert.equal(stillWaiting[0].interactions.find((card) => card.id === second.interaction.id).status, "pending");
      const result = await send(responsePath(second.interaction), approve(second.interaction));
      assert.match(result.answer, /已完成/u);
      assert.equal(phases.get("HIL_LEGACY_FLOW"), 4);
      assert.deepEqual(effects, { draft: 2, protected: 2 });
      const messages = await send(`${path}/messages?userId=customer-one`);
      assert.equal(messages.length, 2);
      assert.deepEqual(messages.find((message) => message.role === "assistant").interactions.map((card) => card.status), ["answered", "approved"]);
      assert.equal((await db.query("SELECT * FROM agent_native_checkpoint_writes WHERE run_id=$1", [first.runId])).rowCount, 0);
      assert.equal(events.filter((event) => event.type === "run.failed").length, 0);
    });

    await t.test("legacy Chat: cancelling a current pending card wins over a later reply and executes no protected write", async () => {
      const first = await send(`/${agent.id}/messages`, { message: "HIL_CANCEL_FLOW", userId: "customer-one", stream: false }, { key: "cancel-human-flow", status: 202 });
      const path = `/conversations/${first.conversationId}/interactions/${first.interaction.id}`;
      await send(`${path}/cancel?userId=other-customer`, {}, { status: 404 });
      await send(`${path}/cancel?userId=customer-one`, {});
      await send(`${path}/respond?userId=customer-one&stream=false`, answer(first.interaction), { status: 409 });
      assert.equal(phases.get("HIL_CANCEL_FLOW"), 2);
      assert.deepEqual(effects, { draft: 3, protected: 2 });
      const detail = await send(`/conversations/${first.conversationId}/runs?userId=customer-one`);
      assert.equal(detail[0].interactions[0].status, "cancelled");
      assert.equal((await db.query("SELECT * FROM agent_native_checkpoint_writes WHERE run_id=$1", [first.runId])).rowCount, 0);
      assert.deepEqual(await send(`/conversations/${first.conversationId}/messages?userId=customer-one`), []);
    });
    assert.equal(requests.length, 10);
  } finally {
    if (app) await app.close();
    if (db) await db.onModuleDestroy();
    await tracer.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}));
