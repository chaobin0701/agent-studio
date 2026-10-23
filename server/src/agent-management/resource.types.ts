import { uiCatalogSchema } from "../tool-management/ui-tool";
import { z } from 'zod';
import { DEFAULT_AGENT_CONFIGURATION } from '../config/agent-config';
import { agentRetrievalSchema } from '../documents/knowledge-config';
import { httpEndpointSchema } from '../tool-management/tool-config';
import { skillResourcesSchema, SKILL_RESOURCE_LIMITS } from './skill-resources';
import { normalizeContract, OutputContractError } from '../ai/agent/output-contract';

const outputContractSchema = z.unknown().transform((value, context) => {
  try { return normalizeContract(value); }
  catch(error) {
    for (const issue of error instanceof OutputContractError ? error.issues : [{path:'$',message:'输出规范无效'}])
      context.addIssue({code:'custom',path:issue.path==='output'?[]:['schema',...issue.path.split('.').filter(p=>p!=='$')],message:issue.message});
    return z.NEVER;
  }
});

export const keySchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const ids = z.array(z.number().int().positive()).max(40).refine(v => new Set(v).size === v.length);
const names = z.array(keySchema).max(40).refine(v => new Set(v).size === v.length);
const runtime = z.object({
  maxToolCalls: z.number().int().min(1).max(20).default(8),
  maxPlannerRounds: z.number().int().min(2).max(30).default(12),
  toolTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxToolResultChars: z.number().int().min(1000).max(50000).default(16000),
}).strict(); // Decisions and tool attempts are independent native budgets.
export const agentExecutionLimitsSchema = z.object({
  maxModelCalls: z.number().int().min(1).max(200).default(32),
  maxToolCalls: z.number().int().min(1).max(200).default(40),
  maxTotalTokens: z.number().int().min(1000).max(2000000).default(120000),
  enabled: z.object({maxModelCalls:z.boolean(),maxToolCalls:z.boolean(),maxTotalTokens:z.boolean()}).strict().optional(),
}).strict();
export const agentCollaborationSchema = z.object({
  memberVersionIds: z.array(z.number().int().positive()).min(1).max(8).refine(v=>new Set(v).size===v.length,'成员版本不能重复'),
  maxDelegations:z.number().int().min(1).max(10).default(3),
  failurePolicy:z.enum(['continue','fail']).default('continue'),
  maxModelCalls:z.number().int().min(1).max(200).optional(),
  maxToolCalls:z.number().int().min(1).max(200).optional(),
  maxTotalTokens:z.number().int().min(1000).max(2000000).optional(),
}).strict();
export const agentSchema = z.object({
  responsibility: z.string().trim().min(1).max(2000),
  promptVersionId: z.number().int().positive(),
  modelPlanVersionId: z.number().int().positive().nullable(),
  embeddingPlanVersionId: z.number().int().positive().nullable().default(null),
  retrieval: agentRetrievalSchema.default(() => agentRetrievalSchema.parse({})),
  toolVersionIds: ids, skillVersionIds: ids, knowledgeBaseIds: ids,
  fileOutputs: z.object({enabled:z.boolean().default(false)}).strict().default({enabled:false}),
  // Absence means legacy request-defined output; never materialize defaults on old versions.
  output: outputContractSchema.optional(),
  skillPolicies: z.array(z.object({
    skillVersionId: z.number().int().positive(), mode: z.enum(['inherit','restricted']),
    allowedTools: names.default([]), allowedKnowledgeBaseIds: ids.default([]),
  }).strict()).max(40).refine(v => new Set(v.map(p => p.skillVersionId)).size === v.length).default([])
    .transform(() => []), // Read historical JSON, but never persist inert Skill execution policies.
  runtime,
  // Task-wide limits apply equally to single and multi Agent; legacy versions keep their old limits.
  executionLimits: agentExecutionLimitsSchema.optional(),
  /** Star collaboration is owned/versioned by the entry Agent; no environment or separate plan binding. */
  collaboration:agentCollaborationSchema.nullable().default(null),
  welcome: z.object({ title: z.string().min(1).max(200), description: z.string().min(1).max(500), suggestedQuestions: z.array(z.string().min(2).max(200)).min(1).max(6) }).strict().default(DEFAULT_AGENT_CONFIGURATION.welcome),
}).strict();
export const skillSchema = z.object({
  description: z.string().trim().min(1).max(2000), category: z.string().max(100).default(''),
  instructions: z.string().trim().max(24000),
  // Compatibility declarations, never execution grants. Skills only contain guidance.
  allowedTools: names.default([]), allowedKnowledgeBaseIds: ids.default([]),
  disableModelInvocation: z.boolean().default(false),
  document: z.string().max(75000).optional(),
  resources: skillResourcesSchema.default([]),
  permissionMode: z.enum(['agent','legacy']).default('agent'),
  // Portable document identity is separate from the immutable legacy resource Key.
  portableName: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  license: z.string().max(1000).optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string().max(100), z.string().max(2000)).refine(v => Object.keys(v).length <= 40).optional(),
  extraFrontmatter: z.record(z.string().max(100), z.json()).refine(v => Object.keys(v).length <= 40).optional(),
  unresolvedTools: z.array(z.string().max(300)).max(40).optional(),
  unresolvedKnowledgeBases: z.array(z.string().max(300)).max(40).optional(),
}).strict().refine(v => v.resources.length === 0 || Buffer.byteLength(JSON.stringify(v)) <= SKILL_RESOURCE_LIMITS.configBytes, '含辅助资料的 Skill 配置总量不能超过 384 KiB');
export const toolSchema = z.object({
  description: z.string().trim().min(1).max(2000),
  type: z.enum(['builtin', 'rest', 'mcp', 'ui']),
  uiCatalog: uiCatalogSchema.optional(),
  target: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).optional(),
  mcpVersionId: z.number().int().positive().optional(),
  parameters: z.record(z.string(), z.unknown()),
  endpoint: httpEndpointSchema.optional(),
  outputSchema: z.record(z.string(),z.unknown()).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxRetries: z.number().int().min(0).max(3).default(3),
  readOnly: z.boolean().default(true),
  idempotencyHeader: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/).optional(),
  requiresApproval: z.boolean().default(false),
}).strict().superRefine((v,c) => {
  if(v.type==='rest' && !v.endpoint) c.addIssue({code:'custom',path:['endpoint'],message:'需要端点'});
  if(v.type!=='rest' && v.type!=='ui' && !v.target) c.addIssue({code:'custom',path:['target'],message:'需要已注册工具'});
  if(v.type==='ui' && (!v.uiCatalog || v.target!=='present' || !v.readOnly || v.requiresApproval || v.maxRetries!==0 || v.endpoint || v.outputSchema)) c.addIssue({code:'custom',message:'UI 工具必须为只读 present，并导入组件目录；不支持审批、重试、端点和输出映射'});
  if(v.type!=='ui' && v.uiCatalog) c.addIssue({code:'custom',message:'只有 UI 工具允许组件目录'});
  if(v.mcpVersionId && v.type!=='mcp')c.addIssue({code:'custom',path:['mcpVersionId'],message:'只有 MCP 工具可以关联 MCP 服务版本'});
  if(!v.readOnly && v.maxRetries>0 && !v.idempotencyHeader) c.addIssue({code:'custom',path:['maxRetries'],message:'写操作自动重试需要幂等键'});
  if(v.type==='rest' && v.readOnly && v.endpoint?.method!=='GET') c.addIssue({code:'custom',path:['readOnly'],message:'只读 REST 工具必须使用 GET'});
});
export const collaborationSchema = z.object({
  coordinatorVersionId: z.number().int().positive(), memberVersionIds: ids,
  edges: z.array(z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).strict()).max(40),
  maxDelegations: z.number().int().min(1).max(10).default(3),
  maxDepth: z.number().int().min(1).max(3).default(1),
  failurePolicy: z.enum(['continue','fail']).default('continue'),
  maxModelCalls:z.number().int().min(1).max(200).default(32),
  maxToolCalls:z.number().int().min(1).max(200).default(40),
  maxTotalTokens:z.number().int().min(1000).max(2000000).default(120000),
}).strict().superRefine((v,c)=> {
  const all = new Set([v.coordinatorVersionId,...v.memberVersionIds]);
  if(all.size!==v.memberVersionIds.length+1) c.addIssue({code:'custom',message:'协调 Agent 与成员不能重复'});
  for(const e of v.edges) if(!all.has(e.from)||!all.has(e.to)||e.from===e.to) c.addIssue({code:'custom',path:['edges'],message:'委派必须发生在计划成员之间'});
});
export const resourceKind = z.enum(['agent','skill','tool','collaboration']);
export type ResourceKind = z.infer<typeof resourceKind>;
export const schemas = { agent: agentSchema, skill: skillSchema, tool: toolSchema, collaboration: collaborationSchema };
export type AgentSpec = z.infer<typeof agentSchema>;
export type SkillSpec = z.infer<typeof skillSchema>;
export type ToolSpec = z.infer<typeof toolSchema>;
export type CollaborationSpec = z.infer<typeof collaborationSchema>;
export type ResourceVersion = { archivedAt?:Date|null; deletedAt?:Date|null; id:number; resourceId:number; key:string; name:string; kind:ResourceKind; enabled:boolean; version:number; status:'draft'|'published'; revision:number; config:any; testedRevision:number|null; testResult:any };
