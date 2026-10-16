import { z } from "zod";
export const modelKindSchema = z.enum(["llm", "embedding"]);
export type ModelKind = z.infer<typeof modelKindSchema>;
export const accountSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    platformKey: z.enum(["volcengine", "openai", "deepseek", "custom"]),
    baseUrl: z.string().trim().url(),
    apiKey: z.string().trim().min(1).max(500),
  })
  .strict();
export const llmDeploymentSchema = z
  .object({
    provider: z.literal("openai-compatible").default("openai-compatible"),
    model: z.string().trim().min(1).max(200),
    timeoutMs: z.number().int().min(1000).max(120000).default(20000),
    contextWindowTokens: z.number().int().min(1024).max(1000000).default(32000),
    maxOutputTokens: z.number().int().min(128).max(32000).default(1200),
    maxRetries: z.number().int().min(0).max(3).default(3),
    streamUsage: z.boolean().default(true),
    supportsImageInput: z.boolean().default(false),
  })
  .strict()
  .refine(
    (c) => c.maxOutputTokens < c.contextWindowTokens,
    "Output must fit context window",
  );
export const embeddingDeploymentSchema = z
  .object({
    provider: z.enum(["openai-compatible", "volcengine-multimodal"]),
    model: z.string().trim().min(1).max(200),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    dimensions: z.number().int().min(1).max(4096),
    maxInputChars: z.number().int().min(200).max(32000).default(8000),
    batchSize: z.number().int().min(1).max(64).default(16),
  })
  .strict();
export type DeploymentSnapshot = {
  id: number;
  accountId: number;
  name: string;
  baseUrl: string;
  config:
    | z.infer<typeof llmDeploymentSchema>
    | z.infer<typeof embeddingDeploymentSchema>;
};
export type PlanConfig = {
  deployments: DeploymentSnapshot[];
  migrated?: boolean;
};
export type PlanVersion = {
  id: number;
  plan_id: number;
  version: number;
  status: "draft" | "published";
  revision: number;
  config: PlanConfig;
  test_signature: string | null;
  test_result: unknown;
  kind: ModelKind;
  name: string;
};
