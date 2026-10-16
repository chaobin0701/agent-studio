import { nativeChat } from "./helpers/native-chat.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSettingsService } from '../dist/config/agent-settings.service.js';
import { DEFAULT_AGENT_CONFIGURATION, agentConfigurationRevision, effectiveAgentConfiguration } from '../dist/config/agent-config.js';
import { SkillRegistry } from '../dist/ai/skills/skill-registry.js';
import { LoadSkillTool } from '../dist/ai/tools/load-skill.tool.js';
import { ToolPolicy } from '../dist/ai/tools/tool-policy.js';
import { ToolRegistry } from '../dist/ai/tools/tool-registry.js';
import { ToolExecutionService } from '../dist/ai/tools/tool-execution.js';
import { z } from 'zod';

const clone = () => structuredClone(DEFAULT_AGENT_CONFIGURATION);
const editable = value => { const { version, answerInstructions, ...settings } = structuredClone(value); return settings; };
function fixture() {
  let row;
  const audits = [];
  const query = async (sql, args = []) => {
    if (sql.startsWith('INSERT INTO agent_settings')) { row ??= { configuration: JSON.parse(args[0]), revision: args[1], version: 1, updatedAt: new Date(), updatedBy: null }; return { rows: [] }; }
    if (sql.startsWith('SELECT configuration')) return { rows: row ? [row] : [] };
    if (sql.startsWith('UPDATE agent_settings')) { row = { configuration: JSON.parse(args[0]), revision: args[1], version: row.version + 1, updatedAt: new Date(), updatedBy: args[2] }; return { rows: [row] }; }
    if (sql.startsWith('INSERT INTO audit_logs')) { audits.push(JSON.parse(args[1])); return { rows: [] }; }
    throw new Error('Unexpected SQL');
  };
  const db = { query, transaction: fn => fn({ query }) };
  const config = { agent: clone() };
  const tools = { toolDefinitions: () => config.agent.runtime.allowedTools.map(name => ({ name })), capabilities: () => [{ system: false, tools: [{ name: 'list_products' }, { name: 'mcp_product_catalog_list_products' }] }] };
  const service = new AgentSettingsService(db, config, { has: id => config.agent.enabledSkills.includes(id) }, tools);
  return { service, audits, config, row: () => row };
}

test('database configuration is seeded once; snapshots are immutable and saves are versioned and audited', async () => {
  const { service, audits, config } = fixture();
  await service.onModuleInit();
  const old = await service.snapshot();
  assert.ok(Object.isFrozen(old.configuration.memory));
  const settings = editable(old.configuration); settings.identity.persona = '新的业务人设';
  const saved = await service.save(7, { revision: old.revision, configurationVersion: old.configurationVersion, settings });
  assert.equal(saved.configurationVersion, 2); assert.equal(saved.updatedBy, 7);
  assert.equal(old.configuration.identity.persona, config.agent.identity.persona);
  assert.equal(audits.length, 1); assert.equal(audits[0].changes[0].path, 'identity.persona');
  await service.onModuleInit();
  assert.equal((await service.snapshot()).configuration.identity.persona, '新的业务人设');
  await service.save(7, { revision: saved.revision, configurationVersion: 2, settings });
  assert.equal(audits.length, 1);
  await assert.rejects(service.save(7, { revision: old.revision, configurationVersion: 1, settings }), e => e.getStatus() === 409);
  await assert.rejects(service.save(7, { revision: saved.revision, configurationVersion: 1, settings }), e => e.getStatus() === 409);
});

test('write contract rejects protocol overrides, unknown capabilities, partial aliases and impossible budgets', async () => {
  const { service } = fixture(); await service.onModuleInit(); const snapshot = await service.snapshot();
  for (const change of [
    s => { s.answerInstructions = 'override'; },
    s => { s.enabledSkills = ['unknown']; },
    s => { s.runtime.allowedTools.push('execute_shell'); },
    s => { s.runtime.allowedTools = s.runtime.allowedTools.filter(n => n !== 'load_skill'); },
    s => { s.runtime.maxPlannerRounds = 1; },
    s => { s.memory.summaryKeepRecentTurns = s.memory.summaryTriggerTurns; },
    s => { s.memory.snapshotTurns = 1; },
  ]) {
    const settings = editable(snapshot.configuration); change(settings);
    await assert.rejects(service.save(7, { revision: snapshot.revision, configurationVersion: 1, settings }), e => e.getStatus() === 400);
  }
});

test('disabled Skills and tool aliases are blocked at execution, not only hidden from the UI', async () => {
  const skills = new SkillRegistry(); skills.register({ id: 'test', name: 'Test', version: '1', description: 'Test', systemInstructions: 'Test' });
  assert.equal((await new LoadSkillTool(skills).execute({ skillId: 'test' }, { enabledSkillIds: [] })).errorCode, 'skill_unavailable');
  const registry = new ToolRegistry(); let calls = 0;
  for (const name of ['list_products', 'mcp_product_catalog_list_products']) registry.register({ name, description: name, inputSchema: z.object({}), execute: async () => { calls++; return { success: true, content: 'ok' }; } });
  const tools = new ToolExecutionService(registry, new ToolPolicy());
  const state = tools.createStateForAgent(['load_skill'], 5, { timeoutMs: 1000, maxResultChars: 1000 });
  for (const name of ['list_products', 'mcp_product_catalog_list_products']) assert.equal((await tools.execute(name, {}, {}, state)).result.success, false);
  assert.equal(calls, 0);
  const config = clone(); config.enabledSkills = [];
  assert.equal(effectiveAgentConfiguration(config).runtime.allowedTools.includes('load_skill'), false);
  assert.equal(config.runtime.allowedTools.includes('load_skill'), true);
});

test('a native request retains its published Prompt/configuration after live defaults change', async () => {
  const current = {agent:clone()}, pinned=clone();pinned.runtime.allowedTools=[];pinned.enabledSkills=[];
  const host=nativeChat({configuration:pinned,businessPrompt:'PINNED_PUBLISHED_PERSONA',configurationVersion:8,respond:request=>{
    assert.match(JSON.stringify(request.messages),/PINNED_PUBLISHED_PERSONA/);
    assert.doesNotMatch(JSON.stringify(request.messages),/CHANGED_DEFAULT_PERSONA/);
    current.agent.identity.persona='CHANGED_DEFAULT_PERSONA';
    assert.ok(!request.tools.some(tool=>['load_skill','run_skill','delegate_agent','execute'].includes(tool.name)));
    return {content:'Native answer'};
  }});
  const result=await host.orchestrator.askDetailed('Task',[], '');
  assert.equal(result.result.answer,'Native answer');assert.equal(host.requests.length,1);
  assert.equal(result.contextSnapshot.agentConfigurationVersion,8);
  assert.equal(host.snapshot.agents.get(1).promptSnapshot.businessPrompt,'PINNED_PUBLISHED_PERSONA');
});

test('tool result limits come from the request snapshot, not a later default change', async () => {
  const config = { agent: clone() }; const registry = new ToolRegistry();
  registry.register({ name: 'search_knowledge', description: 'search', inputSchema: z.object({}), execute: async () => ({ success: true, content: 'x'.repeat(3000) }) });
  const tools = new ToolExecutionService(registry, new ToolPolicy(config));
  const state = tools.createStateForAgent(['search_knowledge'], 1, { timeoutMs: 1000, maxResultChars: 1000 });
  config.agent.runtime.maxToolResultChars = 50000;
  const result = await tools.execute('search_knowledge', {}, {}, state);
  assert.equal(result.result.content.split('\n')[0].length, 1000);
  assert.equal(result.result.metadata.resultTruncated, true);
  assert.equal((await tools.execute('search_knowledge', {}, {}, state)).result.errorCode, 'tool_call_limit_exceeded');
});
