/** Stable business capabilities used by orchestration code.
 *
 * Tool names are provider/adapter details. Code that needs to know what a
 * tool does should use a capability rather than repeating local and MCP names.
 */
export type AgentToolCapability =
  | 'knowledge-search'
  | 'skill';

export const TOOL_CAPABILITIES: Readonly<Record<string, readonly AgentToolCapability[]>> = Object.freeze({
  search_knowledge: ['knowledge-search'],
  load_skill: ['skill'],
});

export function hasToolCapability(name: string, capability: AgentToolCapability): boolean {
  return TOOL_CAPABILITIES[name]?.includes(capability) ?? false;
}
