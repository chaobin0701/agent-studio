import { nativeChat } from "./helpers/native-chat.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { DEFAULT_AGENT_CONFIGURATION, parseAgentConfiguration, readAgentConfiguration, agentConfigurationRevision } from '../dist/config/agent-config.js';
import { AdminAgentConfigController } from '../dist/chat/admin-agent-config.controller.js';
import { ChatController } from '../dist/chat/chat.controller.js';
import { ConversationService } from '../dist/chat/conversation.service.js';
import { nativeSystemPrompt } from '../dist/ai/deep-agents/deep-agent-execution.service.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';
import { AdminAuthGuard } from '../dist/admin/admin-auth.guard.js';
import { PermissionGuard } from '../dist/admin/permission.guard.js';

function config() { return structuredClone(DEFAULT_AGENT_CONFIGURATION); }
const llm = { model: 'active-model', maxOutputTokens: 4096, contextWindowTokens: 64000 };
const skill = { id: 'product_consultation', name: '产品咨询', version: '2.0.0', description: '专项指导', systemInstructions: 'skill rules' };

test('Agent configuration is independently loaded, immutable and revisioned', () => {
  const original = config();
  assert.equal(readAgentConfiguration(''), DEFAULT_AGENT_CONFIGURATION);
  assert.deepEqual(original.memory, {});
  assert.ok(Object.isFrozen(DEFAULT_AGENT_CONFIGURATION));
  assert.ok(Object.isFrozen(DEFAULT_AGENT_CONFIGURATION.welcome.suggestedQuestions));
  assert.throws(() => { DEFAULT_AGENT_CONFIGURATION.memory.recentTurns = 12; }, TypeError);
  original.identity.persona = 'changed';
  assert.notEqual(agentConfigurationRevision(original), agentConfigurationRevision(DEFAULT_AGENT_CONFIGURATION));
  assert.equal(agentConfigurationRevision(config()), agentConfigurationRevision(DEFAULT_AGENT_CONFIGURATION));
});

test('invalid settings fail closed, including impossible memory rules and unknown fields', () => {
  for (const modify of [
    c => { c.welcome.suggestedQuestions = []; },
    c => { c.welcome.suggestedQuestions = ['a']; },
    c => { c.answeringInstructions = ''; },
    c => { c.runtime.maxToolCalls = 0; },
    c => { c.runtime.maxPlannerRounds = 1; },
    c => { c.runtime.allowedTools.push(c.runtime.allowedTools[0]); },
    c => { c.runtime.allowedTools = ['../read']; },
    c => { c.runtime.toolTimeoutMs = 0; },
    c => { c.runtime.maxToolResultChars = 999999; },
    c => { c.apiKey = 'not-to-be-logged'; },
  ]) {
    const value = config(); modify(value);
    assert.throws(() => parseAgentConfiguration(value), error => {
      assert.match(error.message, /Invalid Agent configuration/);
      assert.doesNotMatch(error.message, /not-to-be-logged/);
      return true;
    });
  }
  assert.throws(() => readAgentConfiguration('/missing/config.json'), /AGENT_CONFIG_PATH/);
});

test('admin view reads the active configuration and model, not model defaults or secrets', async () => {
  const agent = config(); agent.identity.persona = 'custom persona';
  const host = nativeChat({configuration: agent, skills: [skill], respond: () => ({content: "unused"})});
  const controller = new AdminAgentConfigController({...llm, withPinnedModelPlan: (_plan, task) => task()}, {snapshot: async () => host.snapshot});
  const view = await controller.inspect();
  assert.equal(view.identity.persona, 'custom persona');
  assert.equal(view.model.name, 'active-model');
  assert.equal(view.model.maxOutputTokens, 4096);
  assert.equal(view.model.contextWindowTokens, 64000);
  assert.equal(view.runtime.answerValidation, 'format_only');
  assert.equal(view.readOnly, true);
  assert.equal(view.runtime.skillId, undefined);
  assert.equal(view.runtime.maxToolCalls, agent.runtime.maxToolCalls);
  assert.equal(view.availableSkills[0].id, skill.id);
  assert.match(view.prompts.assembled, /Complete the authorized task/);
  assert.equal(view.source, 'agent_resources');
  assert.equal(view.runtime.engine, 'deepagents');
  assert.equal(view.prompts.runtimeManaged, true);
  assert.doesNotMatch(JSON.stringify(view), /secret-value|apiKey|jwt/);
});

test('admin endpoint is protected by authentication and its own read permission', async () => {
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, AdminAgentConfigController.prototype.inspect), ['agent_config.read', 'agent_config.manage']);
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, AdminAgentConfigController.prototype.save), ['agent_config.manage']);
  assert.deepEqual(Reflect.getMetadata('__guards__', AdminAgentConfigController), [AdminAuthGuard, PermissionGuard]);
  for (const granted of [false, true]) {
    const rows = granted ? [{ roleId: 1 }] : [];
    const database = { db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => rows }) }) }) }) } };
    const guard = new PermissionGuard({ getAllAndOverride: () => ['agent_config.read'] }, database);
    const context = { getHandler: () => {}, getClass: () => {}, switchToHttp: () => ({ getRequest: () => ({ admin: { id: 1 },workspacePermissionCodes:granted?['agent_config.read']:[] }) }) };
    if (granted) assert.equal(await guard.canActivate(context), true);
    else await assert.rejects(guard.canActivate(context), error => error.getStatus() === 403);
  }
});

test('public welcome endpoint returns only approved presentation fields and creates no conversation', () => {
  const fail = () => { throw new Error('No session or model calls allowed'); };
  const agent = config();
  const controller = new ChatController({ ask: fail }, {}, { create: fail, session: fail }, {}, { agent });
  assert.deepEqual(controller.presentation(), agent.welcome);
  assert.deepEqual(Object.keys(controller.presentation()).sort(), ['description', 'suggestedQuestions', 'title']);
  assert.doesNotMatch(JSON.stringify(controller.presentation()), /persona|summaryInstructions|allowedTools/);
});

test('native system prompt consumes the selected business Prompt', () => {
  const agent = config();
  agent.identity.name = '测试助手'; agent.identity.role = '测试角色'; agent.identity.persona = '测试人设';
  const prompt = nativeSystemPrompt({promptSnapshot:{businessPrompt:agent.identity.persona},spec:{responsibility:agent.identity.role}});
  assert.ok(prompt.includes(agent.identity.persona));
  assert.ok(!prompt.includes('PLANNER_PROTOCOL'));

});

test('summary uses model-window-derived thresholds and the system instruction', async () => {
  const agent = config();
  const messages = Array.from({ length: 24 }, (_, index) => ({ id: index + 1, role: index % 2 ? 'assistant' : 'user', content: `message ${index}` }));
  let count = 4;
  const modelCalls = [];
  const writes = [];
  const db = {
    query: async (sql, values) => {
      if (sql.startsWith('SELECT summary_through_message_id')) return { rows: [{ summaryThroughMessageId: null }] };
      if (sql.includes('FROM conversation_messages')) {
        assert.equal(values[2], 100);
        return { rows: messages.slice(0, count) };
      }
      throw new Error(`Unexpected query ${sql}`);
    },
    transaction: async fn => fn({ query: async (sql, values) => { writes.push({ sql, values }); return { rowCount: 1 }; } }),
  };
  const model = { model: 'test', completeDetailed: async (system, user) => {
    modelCalls.push({ system, user: JSON.parse(user) });
    return { content: 'x'.repeat(200), model: 'test', inputTokens: 10, outputTokens: 20, totalTokens: 30, attempts: 1 };
  } };
  const service = new ConversationService(db, {}, model, undefined, { agent });
  await service.updateSummary('conversation', 'previous');
  assert.equal(modelCalls.length, 0);
  count = 24;
  await service.updateSummary('conversation', 'previous');
  assert.equal(modelCalls.length, 1);
  assert.match(modelCalls[0].system, /当前主题/);
  assert.equal(modelCalls[0].user.messages.length, 18);
  assert.equal(modelCalls[0].user.previousSummary, 'previous');
  assert.equal(writes[0].values[1].length, 200);
  assert.equal(writes[0].values[2], 18);
});

test('snapshot derives message and tool-transcript bounds from the active model window', async () => {
  const statements = [];
  const database = { query: async (sql, values) => {
    statements.push({ sql, values });
    if (sql.startsWith('SELECT id, title, summary')) return { rows: [{ id: 'conversation', summary: '' }] };
    return { rows: [] };
  } };
  await new ConversationService(database, {}, { contextWindowTokens: 64000 }, undefined, { agent: config() }).snapshot('owner', 'conversation');
  assert.equal(statements.find(item => item.sql.includes('FROM conversation_messages')).values[1], 8);
  assert.equal(statements.find(item => item.sql.includes('FROM chat_traces')).values[1], 71);
});
