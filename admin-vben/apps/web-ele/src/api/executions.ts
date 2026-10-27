import { managementApi } from "./management";

export interface Attempt {
  attempt?: number;
  maxAttempts?: number;
  model?: string;
  target?: string;
  durationMs?: number;
  ok?: boolean;
  fallback?: boolean;
  errorCode?: string;
  retryable?: boolean;
  delayMs?: number;
}
export interface ExecutionStep {
  type?: string;
  stage?: string;
  name?: string;
  skillId?: string;
  plannerRound?: number;
  ok?: boolean;
  durationMs?: number;
  model?: string;
  totalTokens?: number;
  attempts?: number;
  retryExhausted?: boolean;
  errorCode?: string;
  retrievalMode?: string;
  hitCount?: number;
  reused?: boolean;
  deferred?: boolean;
  attemptsTrail: Attempt[];
}
export interface ExecutionModel {
  id?: string;
  purpose?: string;
  ok?: boolean;
  errorCode?: string;
  errorKind?: string;
  retryExhausted?: boolean;
  model?: string;
  plannerRound?: number;
  durationMs?: number;
  attempts?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  finishReason?: string;
  attemptsTrail: Attempt[];
}
export interface ExecutionTool {
  name?: string;
  ok?: boolean;
  durationMs?: number;
  attempts?: number;
  errorCode?: string;
  retryExhausted?: boolean;
  reused?: boolean;
  deferred?: boolean;
  attemptsTrail: Attempt[];
  retrieval: {
    embeddingPlanVersionId?: number;
    embeddingCalls?: number;
    libraries: {
      knowledgeBaseId?: number;
      indexVersionId?: number;
      requestedRetrievalMode?: string;
      retrievalMode?: string;
      fallbackReason?: string;
    }[];
  };
}
export interface ExecutionView {
  entryPoint?: string;
  runId?: string;
  outputContract?: {
    mode?: string;
    source?: string;
    schemaHash?: string;
    agentVersionId?: number;
  };
  outputValidation?: { status?: string };
  outputIssues?: { path: string; message: string }[];
  limits: Record<string, number>;
  executionEngine?: string;
  graphVersion?: string;
  currentNode?: string;
  graphNodes: string[];
  specializedFlows?: {
    key?: string;
    version?: string;
    ok?: boolean;
    durationMs?: number;
    nodes?: number;
    modelCalls?: number;
    toolCalls?: number;
    errorCode?: string;
  }[];
  composition: {
    agentId?: number;
    mode?: string;
    entryVersionId?: number;
    agents: {
      agentId?: number;
      key?: string;
      name?: string;
      versionId?: number;
      version?: number;
      promptVersionId?: number;
      modelPlanVersionId?: number;
      embeddingPlanVersionId?: number;
      knowledge: { id?: number; indexVersionId?: number }[];
    }[];
  };
  steps: ExecutionStep[];
  models: ExecutionModel[];
  tools: ExecutionTool[];
  tasks: {
    type?: string;
    key?: string;
    agentVersionId?: number;
    depth?: number;
    ok?: boolean;
    errorCode?: string;
    totalTokens?: number;
    execution: ExecutionView;
  }[];
  budget: Record<string, number>;
  timing: Record<string, number | null>;
  error: {
    phase?: string;
    errorCode?: string;
    errorKind?: string;
    attempts?: number;
  };
  output: {
    status?: string;
    artifacts: { id?: string; kind?: string }[];
    references: { id?: string; kind?: string; title?: string }[];
  };
  externalTrace: { sampled: boolean };
}
export interface ExecutionRecord {
  id: string;
  kind: string;
  agentId?: string;
  conversationId?: string | null;
  question: string;
  finalAnswer?: string;
  refused?: boolean;
  status: string;
  errorCode?: string;
  model?: string;
  engine?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  createdAt: string;
}
export type ExecutionDetail = ExecutionRecord & { execution: ExecutionView };
export interface ConversationTurn {
  key: string;
  userMessageId: number | null;
  traceId: string | null;
  question: string;
  finalAnswer: string | null;
  refused: boolean | null;
  status: string;
  errorCode: string | null;
  totalTokens: number | null;
  durationMs: number | null;
  createdAt: string;
}
export interface ExecutionConversation {
  conversation: { id: string; title: string; createdAt: string; updatedAt: string } | null;
  items: ConversationTurn[];
  total: number;
  page: number;
  pageSize: number;
}
export const executionsApi = {
  list: (query: URLSearchParams) =>
    managementApi.get<{ items: ExecutionRecord[]; total: number }>(
      `/executions?${query}`,
    ),
  detail: (id: string) =>
    managementApi.get<ExecutionDetail>(`/executions/${encodeURIComponent(id)}`),
  conversation: (id: string, page?: number) =>
    managementApi.get<ExecutionConversation>(
      `/executions/${encodeURIComponent(id)}/conversation${page ? `?page=${page}` : ""}`,
    ),
  external: (id: string) =>
    managementApi.get<{
      available: boolean;
      reason: string | null;
      url: string | null;
    }>(`/executions/${encodeURIComponent(id)}/phoenix`),
};
