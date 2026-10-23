import type { Request } from "express";
import type { ProcessEvent } from "../chat/chat.service";
import type { ContextEstimate } from "../chat/context-governor";
import type { ApplicationLimitSettings } from './application-limits';
import type {
  AgentArtifact,
  AgentReference,
  JsonValue,
} from "../ai/agent/execution-contract";

export const INTERNAL_APP_ID = "00000000-0000-4000-8000-000000000001";
export const ACCESS_SCOPES = [
  "chat:write",
  "conversations:read",
  "conversations:delete",
  "usage:read",
] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];
export type IntegrationApp = {
  workspaceId: number;
  agentId: number;
  environment: "dev" | "test" | "prod";
  id: string;
  name: string;
  enabled: boolean;
  websiteEnabled: boolean;
  apiEnabled: boolean;
  allowedOrigins: string[];
  scopes: AccessScope[];
  requestsPerMinute: number;
  concurrency: number;
  dailyRequests: number;
  dailyTokenLimit: number | null;
  limitSettings?: ApplicationLimitSettings;
  authVersion: number;
  isInternal: boolean;
  createdAt: string;
  updatedAt: string;
};
export type IntegrationIdentity = {
  app: IntegrationApp;
  scopes: AccessScope[];
  kind: "website" | "api";
  ownerId?: string;
  keyId?: string;
};
export type IntegrationRequest = Request & { integration: IntegrationIdentity };
/** Shared admission/accounting result; generic Runs do not need a conversation. */
export type IntegrationCallResult = {
  runId: string | null;
  traceId: string | null;
  usage?: PublicAgentResult["usage"];
};
export type PublicAgentResult = {
  contextUsage?: import("../chat/context-governor").ModelContextUsage;
  artifacts?: AgentArtifact[];
  uiBlocks?: import("../tool-management/ui-tool").UiBlock[];
  references?: AgentReference[];
  structured?: JsonValue;
  progressEvents?: ProcessEvent[];
  conversationId: string;
  runId: string | null;
  traceId: string | null;
  status: "completed";
  answer: string;
  refused: boolean;
  citations: unknown[];
  context?: ContextEstimate;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reservedTokens: number;
    unknownModelCalls: number;
    accounting: "actual" | "pending" | "incomplete";
    includesSummary: boolean;
  };
};
