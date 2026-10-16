/** Per-run context passed to a tool. It is intentionally not a chat history. */
export interface ToolContext {
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly userId?: string;
  readonly tenantId?: string;
  readonly permissions: readonly string[];
  readonly enabledSkillIds?: readonly string[];
  readonly signal?: AbortSignal;
  readonly approvedTools?: readonly string[];
  readonly state: Map<string, unknown>;
}
