import { z } from 'zod';

const configFields = z.object({
  indexMode: z.enum(['economy', 'high_quality']).default('economy'),
  retrievalMode: z.enum(['fulltext', 'vector', 'hybrid']).default('fulltext'),
  chunkMode: z.enum(['general', 'parent_child']).default('general'),
  chunkChars: z.number().int().min(200).max(4000).default(800),
  overlapChars: z.number().int().min(0).max(400).default(60),
  parentChars: z.number().int().min(500).max(6000).default(2400),
  childChars: z.number().int().min(100).max(2000).default(500),
  childOverlapChars: z.number().int().min(0).max(200).default(50),
  embeddingProfileId: z.number().int().positive().nullable().default(null),
  topK: z.number().int().min(1).max(8).default(5),
  lexicalThreshold: z.number().min(0).max(1).default(0.15),
  vectorThreshold: z.number().min(-1).max(1).default(0.65),
}).strict();
export const knowledgeConfigSchema = configFields.superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.overlapChars >= value.chunkChars) invalid('Overlap must be smaller than chunk size');
  if (value.childOverlapChars >= value.childChars || value.childChars > value.parentChars) invalid('Invalid parent/child sizes');
  if (value.indexMode === 'economy' && (value.retrievalMode !== 'fulltext' || value.embeddingProfileId !== null)) invalid('Economy mode uses fulltext without embeddings');
  if (value.indexMode === 'high_quality' && value.embeddingProfileId === null) invalid('High quality requires an embedding profile');
});
export type KnowledgeConfig = z.infer<typeof knowledgeConfigSchema>;

export const processingConfigSchema = configFields.pick({
  chunkMode: true, chunkChars: true, overlapChars: true, parentChars: true,
  childChars: true, childOverlapChars: true,
}).strict().superRefine((v, ctx) => {
  if (v.overlapChars >= v.chunkChars) ctx.addIssue({ code: 'custom', message: 'Overlap must be smaller than chunk size' });
  if (v.childOverlapChars >= v.childChars || v.childChars > v.parentChars) ctx.addIssue({ code: 'custom', message: 'Invalid parent/child sizes' });
});
export const indexConfigSchema = configFields.pick({ indexMode: true, embeddingProfileId: true }).strict()
  .superRefine((v, ctx) => {
    if ((v.indexMode === 'high_quality') !== (v.embeddingProfileId !== null))
      ctx.addIssue({ code: 'custom', message: '全文索引不使用向量模型，向量索引必须选择模型方案' });
  });
export const retrievalConfigSchema = configFields.pick({
  retrievalMode: true, topK: true, lexicalThreshold: true, vectorThreshold: true,
}).strict();
export type RetrievalConfig = z.infer<typeof retrievalConfigSchema>;
export const agentRetrievalSchema = retrievalConfigSchema.extend({
  // Keep auto readable for immutable historical versions; new Agents default to fulltext.
  retrievalMode: z.enum(['auto','fulltext','vector','hybrid']).default('fulltext'),
  contextChars: z.number().int().min(1000).max(50000).default(12000),
}).strict();
export type AgentRetrieval = z.infer<typeof agentRetrievalSchema>;
export type BuildConfig = z.infer<typeof processingConfigSchema> & z.infer<typeof indexConfigSchema>;
const pick = (value: unknown, keys: string[]) => Object.fromEntries(
  Object.entries((value ?? {}) as Record<string, unknown>).filter(([key]) => keys.includes(key)),
);
export function processingSettings(value: unknown) {
  return processingConfigSchema.parse(pick(value, Object.keys(processingConfigSchema.shape)));
}
export function indexSettings(value: unknown) {
  return indexConfigSchema.parse(pick(value, Object.keys(indexConfigSchema.shape)));
}
export function buildSettings(value: unknown): BuildConfig {
  return { ...processingSettings(value), ...indexSettings(value) };
}
export function retrievalSettings(value: unknown): RetrievalConfig {
  return retrievalConfigSchema.parse(pick(value, Object.keys(retrievalConfigSchema.shape)));
}
/** Historical index versions have retrieval fields; capability comes from the index,
 * while current (or request-snapshotted) retrieval parameters remain independent. */
export function effectiveRetrieval(index: unknown, retrieval: unknown): RetrievalConfig {
  const settings = retrievalSettings(retrieval);
  return indexSettings(index).indexMode === 'economy' ? { ...settings, retrievalMode: 'fulltext' } : settings;
}

export const sourceLocatorSchema = z.object({
  type: z.enum(['markdown_lines', 'pdf_page', 'docx_paragraph', 'faq_entry']),
  start: z.number().int().positive(), end: z.number().int().positive(),
}).strict().refine((v) => v.end >= v.start);

export const documentBlockSchema = z.object({
  ordinal: z.number().int().positive(), blockType: z.enum(['paragraph', 'code', 'page', 'faq']),
  headingPath: z.string(), content: z.string().min(1), sourceLocator: sourceLocatorSchema,
}).strict();
