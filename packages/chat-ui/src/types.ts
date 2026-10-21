export interface ChatSession {
  id: string;
  title: string;
  updatedAt?: string;
  agentName?: string;
}
export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status?: "uploading" | "processing" | "ready" | "failed" | "expired";
  error?: string;
  previewUrl?: string;
}
/** Server-owned interaction data. Approval arguments are redacted by the API. */
export interface ChatInteraction {
  id: string;
  runId: string;
  kind: "question" | "approval";
  status:
    "pending" | "answered" | "skipped" | "approved" | "rejected" | "expired" | "cancelled";
  revision: number;
  expiresAt: string;
  question?: string;
  options?: Array<{ id: string; label: string }>;
  allowCustom?: boolean;
  toolName?: string;
  description?: string;
  arguments?: Record<string, unknown>;
  answer?: { optionId?: string; text?: string; skipped?: true };
}
export type ChatInteractionResponse =
  | {
      kind: "question";
      interactionId: string;
      revision: number;
      optionId?: string;
      text?: string;
      skip?: true;
    }
  | {
      kind: "approval";
      interactionId: string;
      revision: number;
      decision: "approve" | "reject";
    };
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?:
    "running" | "waiting" | "completed" | "failed" | "cancelled" | "expired";
  interactions?: ChatInteraction[];
  attachments?: ChatAttachment[];
  progress?: Array<string | { id: string; text: string; status?: string }>;
  error?: string;
  traceId?: string;
  structured?: unknown;
  agentVersion?: number;
  runId?: string;
  requestId?: string;
  artifacts?: Array<{
    kind: string;
    id?: string;
    data?: Record<string, unknown>;
  }>;
  references?: Array<{ kind: string; id: string; title?: string }>;
  contextUsage?: {
    model: string;
    contextWindowTokens: number;
    inputBudgetTokens: number;
    estimatedInputTokens: number;
    remainingInputTokens: number;
    usagePercent: number;
    measurementSource: "heuristic" | "provider";
    maxOutputTokens: number;
    safetyBufferTokens: number;
    measuredAt: string;
    includesDraft: false;
  };
}
export interface ChatQuota {
  scope: "application-shared";
  resetAt: string;
  timezone: string;
  checkedAt: string;
  requests?: { limit: number; used: number; remaining: number };
  tokens?: { limit: number; used: number; reserved: number; remaining: number; unsettled: boolean };
}
