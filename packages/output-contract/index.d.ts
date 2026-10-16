export type JsonSchema = Record<string, any>;
export type Contract = { mode: "text" } | { mode: "json"; schema: JsonSchema };
export type ResolvedContract = Contract & {
  source: "legacy" | "agent" | "request";
};
export type ContractIssue = { path: string; message: string };
export class OutputContractError extends Error {
  code: string;
  issues: ContractIssue[];
  constructor(code: string, issues: ContractIssue[]);
}
export function normalizeSchema(value: unknown): JsonSchema;
export function normalizeContract(value: unknown): Contract;
export function resolveContract(
  configured: unknown,
  requested?: unknown,
): ResolvedContract;
export function validateStructured(
  schema: unknown,
  value: unknown,
): ContractIssue[];
export function parseJson(text: string): {
  value?: any;
  error?: string;
  line?: number;
  column?: number;
};
export function schemaExample(schema: unknown): unknown;
