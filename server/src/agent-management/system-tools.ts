/** Code-owned capabilities: never supplied or overridden by managed resources. */
export const FOUNDATION_TOOL_KEYS = ['search_knowledge', 'load_skill'] as const;
// Historical identities stay reserved; no implementation or execution callback
// is registered. Native SDK task middleware owns authorized member delegation.
export const RETIRED_TASK_TOOL_KEYS = ['run_skill', 'delegate_agent'] as const;
export const SYSTEM_TOOL_KEYS = [...FOUNDATION_TOOL_KEYS, ...RETIRED_TASK_TOOL_KEYS] as const;

export function isFoundationTool(key: string): boolean {
  return FOUNDATION_TOOL_KEYS.some(name => name === key);
}

export function isSystemTool(key: string): boolean {
  return SYSTEM_TOOL_KEYS.some(name => name === key);
}

export function isFoundationResource(resource: {kind: string; key: string; config?: {target?: string}}): boolean {
  return resource.kind === 'tool' && (isFoundationTool(resource.key) || isFoundationTool(resource.config?.target ?? ''));
}

/** Runtime-owned/retired bindings are readable history, never managed abilities. */
export function isRuntimeToolResource(resource: {kind: string; key: string; config?: {target?: string}}): boolean {
  return resource.kind === 'tool' && (isSystemTool(resource.key) || isSystemTool(resource.config?.target ?? ''));
}
