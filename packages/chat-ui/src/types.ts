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
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "running" | "completed" | "failed" | "cancelled" | "expired";
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
}
