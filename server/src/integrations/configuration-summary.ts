import type { CompositionSnapshot } from '../agent-management/runtime-scope';
import type { IntegrationApp } from './integration.types';
import { applicationLimit } from './application-limits';
import { configuredExecutionBudget } from '../ai/agent/execution-budget';

type NamedVersion = { name: string; version: string };
export type ConfigurationSummary = {
  kind: 'recorded-turn'; capturedAt: string; runId: string;
  agent: NamedVersion; modelPlan: NamedVersion; prompt: NamedVersion;
  tools: NamedVersion[]; skills: NamedVersion[];
  mcp: (NamedVersion & { toolCount: number })[]; knowledge: NamedVersion[];
  retrieval: { mode: string; topK: number; contextChars: number };
  collaboration: { mode: 'single' | 'multi'; members: NamedVersion[] };
  output: string; budgets: { modelCalls?: number; toolCalls?: number; tokens?: number };
  application: { name: string; policy: { dailyRequests?: number; dailyTokens?: number; requestsPerMinute?: number } };
};
export type SummaryResource = { id: number; name: string; version: number; toolType?: string; mcpVersionId?: number };
export function configurationSummary(snapshot: CompositionSnapshot, app: IntegrationApp, runId: string,
  resources: SummaryResource[], mcpServices: { id: number; name: string; version: number }[],
  knowledge: { id: number; name: string }[]): ConfigurationSummary {
  const entry = snapshot.agents.get(snapshot.entryVersionId)!;
  const named = (item: { name: string; version: string | number }): NamedVersion => ({ name: item.name, version: `v${item.version}` });
  const selected = resources.filter(item => entry.spec.toolVersionIds.includes(item.id));
  const mcpIds = [...new Set(selected.filter(item => item.toolType === 'mcp').map(item => item.mcpVersionId!))];
  const prompt = Object.values(entry.promptSnapshot.prompts).find(item => item.versionId === entry.spec.promptVersionId)!;
  const limits = entry.spec.executionLimits;
  const budget = configuredExecutionBudget(entry.spec.runtime, entry.spec.collaboration ?? undefined, limits);
  const policy = Object.fromEntries(([
    ['dailyRequests', 'dailyRequests'], ['dailyTokenLimit', 'dailyTokens'], ['requestsPerMinute', 'requestsPerMinute'],
  ] as const).flatMap(([key, label]) => { const value = applicationLimit(app, key); return value === null ? [] : [[label, value]]; }));
  return {
    kind: 'recorded-turn', capturedAt: snapshot.createdAt, runId,
    agent: named(entry.version), modelPlan: { name: entry.modelPlan!.name, version: `v${entry.modelPlan!.version}` },
    prompt: { name: prompt.key, version: `v${prompt.version}` },
    tools: selected.filter(item => item.toolType !== 'mcp').map(named),
    skills: resources.filter(item => entry.spec.skillVersionIds.includes(item.id)).map(named),
    mcp: mcpIds.map(id => ({ ...named(mcpServices.find(item => item.id === id)!), toolCount: selected.filter(item => item.mcpVersionId === id).length })),
    knowledge: entry.knowledge.map(item => ({ name: knowledge.find(k => k.id === item.id)!.name, version: item.indexVersionId === null ? '未建立索引' : `索引 #${item.indexVersionId}` })),
    retrieval: { mode: entry.spec.retrieval.retrievalMode, topK: entry.spec.retrieval.topK, contextChars: entry.spec.retrieval.contextChars },
    collaboration: { mode: snapshot.mode, members: [...snapshot.agents.values()].filter(item => item.version.id !== entry.version.id).map(item => named(item.version)) },
    output: entry.spec.output?.mode === 'json' ? '结构化输出' : selected.some(item => item.toolType === 'ui') ? '文本与生成式UI' : '文本',
    budgets: {
      ...(limits?.enabled?.maxModelCalls === false ? {} : { modelCalls: budget.maxModelCalls }),
      ...(limits?.enabled?.maxToolCalls === false ? {} : { toolCalls: budget.maxToolCalls }),
      ...(budget.maxTotalTokens === undefined ? {} : { tokens: budget.maxTotalTokens }),
    },
    application: { name: app.name, policy },
  };
}
/** Visitor projection: only resource identity/count/version; execution policy stays administrative. */
export function publicConfiguration(summary: ConfigurationSummary | null) {
  if (!summary) return null;
  const { capturedAt, agent, tools, skills, mcp, knowledge } = summary;
  return { capturedAt, agent, tools, skills, mcp, knowledge };
}
