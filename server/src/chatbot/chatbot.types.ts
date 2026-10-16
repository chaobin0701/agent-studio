import type { IntegrationIdentity } from "../integrations/integration.types";
import type { PublicRunResult } from "../executions/run-request";
export type ChatbotPrincipal =
  | { adminId: number }
  | { identity: IntegrationIdentity; owner: string };
export type ChatbotEvent = { event: string; data: unknown };
export type ChatbotTurn = {
  id: string;
  sessionId: string;
  requestId: string;
  requestFingerprint: string;
  question: string;
  partialAnswer: string;
  progress: unknown[];
  status: "running" | "completed" | "failed" | "cancelled" | "expired";
  response: PublicRunResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  agentVersionId: number;
  agentVersion: number;
  traceId: string | null;
  createdAt: string;
  finishedAt: string | null;
};
