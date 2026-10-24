import { z } from "zod";

// Schema identifiers only: never argument values or vendor validator messages.
const issueSchema = z.object({
  path: z.string().max(256).regex(/^(?:\/(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\*|\d{1,4}))*$/),
  component: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/).optional(),
  field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  keyword: z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
});
export type ToolValidationIssue = z.infer<typeof issueSchema>;
export type ToolValidationDiagnostics = { catalogVersion?: string; issues: ToolValidationIssue[] };

export function safeToolValidation(value: unknown): ToolValidationDiagnostics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const issues = (Array.isArray(source.issues) ? source.issues.slice(0, 12) : []).flatMap(issue => {
    const parsed = issueSchema.safeParse(issue);
    return parsed.success ? [parsed.data] : [];
  });
  if (!issues.length) return undefined;
  return { ...(typeof source.catalogVersion === "string" && /^[a-f0-9]{64}$/.test(source.catalogVersion) ? { catalogVersion: source.catalogVersion } : {}), issues };
}
