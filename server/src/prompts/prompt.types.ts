import { z } from 'zod';

export const promptTypeSchema = z.enum(['system','planner','answer','tool','summary','classification','guardrail','welcome']);
export const environmentSchema = z.enum(['dev','test','prod']);
export type PromptType = z.infer<typeof promptTypeSchema>;
export type PromptEnvironment = z.infer<typeof environmentSchema>;
export type PromptVariable = { type: 'string'|'number'|'boolean'|'object'|'array'; required: boolean; description?: string };
export type PromptVariableMap = Record<string, PromptVariable>;
export type PromptResource = { id:number; promptKey:string; name:string; promptType:PromptType; description:string; updatedAt:string };
export type PromptVersion = PromptResource & { versionId:number; version:number; revision:number; sourceVersionId:number|null; status:'draft'|'published'; template:string; variables:PromptVariableMap; changeNote:string; createdAt:string; publishedAt:string|null; environments:PromptEnvironment[] };
