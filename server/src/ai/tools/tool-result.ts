import type {AgentArtifact,AgentReference} from '../agent/execution-contract';
export interface ToolResult {
  readonly artifacts?:readonly AgentArtifact[];
  readonly references?:readonly AgentReference[];
  readonly success: boolean;
  readonly content: string;
  readonly data?: unknown;
  readonly errorCode?: string;
  readonly metadata?: Record<string, unknown>;
}
