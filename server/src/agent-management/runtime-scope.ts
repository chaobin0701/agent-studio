import { agentOutputContract } from '../ai/agent/output-contract';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentTool } from '../ai/tools/agent-tool';
import type { SkillDefinition } from '../ai/skills/skill.types';
import type { AgentConfigurationSnapshot } from '../config/agent-config';
import type { PromptRuntimeSnapshot } from '../prompts/prompt-runtime.service';
import type { PlanVersion } from '../model-management/model-management.types';
import type { AgentSpec, CollaborationSpec, ResourceVersion, SkillSpec } from './resource.types';
import type { RetrievalConfig } from '../documents/knowledge-config';
import type { EmbeddingProfile } from '../documents/profile-embedding';
export type KnowledgeScope = { id:number; indexVersionId:number|null; retrievalConfig?:RetrievalConfig }[];
export type ResolvedAgent = {
  version:ResourceVersion; spec:AgentSpec; configurationSnapshot:AgentConfigurationSnapshot;
  promptSnapshot:PromptRuntimeSnapshot; modelPlan:PlanVersion|null;
  embeddingPlan:PlanVersion|null;
  embeddingProfile?:EmbeddingProfile;
  tools:Map<string,AgentTool>; skills:Map<string,SkillDefinition>; skillSpecs:Map<string,SkillSpec>;
  knowledge:KnowledgeScope;
};
export type CompositionSnapshot = { workspaceId:number; agentId:number; environment:'dev'|'test'|'prod'; mode:'single'|'multi'; entryVersionId:number; previewDraft?:{versionId:number;revision:number}; plan?:ResourceVersion; collaboration?:CollaborationSpec; agents:Map<number,ResolvedAgent>; createdAt:string };
export const invocationScope = new AsyncLocalStorage<{ agentId:number; environment:'dev'|'test'|'prod'; snapshot?:CompositionSnapshot }>();
export const runtimeScope = new AsyncLocalStorage<ResolvedAgent>();
export function freeze<T>(v:T, seen=new WeakSet<object>()):T {
 if(!v || typeof v!=='object' || seen.has(v) || Object.isFrozen(v)) return v;
 seen.add(v);
 if(v instanceof Map) {
  for(const value of v.values()) freeze(value,seen);
  for(const method of ['set','delete','clear']) Object.defineProperty(v,method,{value:()=>{throw new TypeError('Request snapshot is immutable');}});
 } else if(Array.isArray(v)||Object.getPrototypeOf(v)===Object.prototype) {
  for(const c of Object.values(v)) freeze(c,seen);
 } else return v; // Registry service instances are not snapshot-owned values.
 return Object.freeze(v);
}
export function compositionMetadata(s:CompositionSnapshot) {
 return { workspaceId:s.workspaceId,agentId:s.agentId,mode:s.mode, createdAt:s.createdAt, entryVersionId:s.entryVersionId,
  ...(s.previewDraft?{previewDraft:s.previewDraft}:{}),
  collaboration:s.collaboration ? { ...s.collaboration, entryVersionId:s.entryVersionId,
    ...(s.plan?{key:s.plan.key,versionId:s.plan.id,version:s.plan.version}:{}) }:null,
  agents:[...s.agents.values()].map(a=>({agentId:a.version.resourceId,key:a.version.key,name:a.version.name,versionId:a.version.id,version:a.version.version,promptVersionId:a.spec.promptVersionId,modelPlanVersionId:a.modelPlan?.id??null,embeddingPlanVersionId:a.embeddingPlan?.id??null,fileOutputsEnabled:a.spec.fileOutputs?.enabled??false,executionLimits:a.spec.executionLimits??null,retrieval:a.spec.retrieval,...(a.spec.output===undefined?{}:{outputContract:((c)=>({mode:c.mode,source:c.source,schemaHash:c.schemaHash,agentVersionId:c.agentVersionId}))(agentOutputContract(a.spec.output,a.version.id))}),toolVersionIds:a.spec.toolVersionIds,skillVersionIds:a.spec.skillVersionIds,knowledge:a.knowledge})) };
}

export function agentMemoryScope(s:CompositionSnapshot) {
 return createHash('sha256').update(JSON.stringify({...compositionMetadata(s),createdAt:undefined})).digest('hex');
}
