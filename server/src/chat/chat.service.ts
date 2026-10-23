import type { CompositionSnapshot } from '../agent-management/runtime-scope';
import { LlmService } from './llm.service';
import { Injectable, Optional } from '@nestjs/common';
import { SearchHit } from '../documents/fuse-search-results';
import { PreviousTurnDto } from './chat.dto';
import { ChatOrchestratorService } from './chat-orchestrator.service';
import type { AgentTranscriptMessage } from './agent-transcript';
import type { AgentConfigurationSnapshot } from '../config/agent-config';
import type { RequestContext } from './request-context';
import type { RuntimeContextBlock } from '../ai/context/context-contribution';
import type { PromptRuntimeSnapshot } from '../prompts/prompt-runtime.service';
import type { ContextEstimate } from './context-governor';
import type { RetryStatusEvent } from './llm.service';
import type {AgentArtifact,AgentReference,JsonValue} from '../ai/agent/execution-contract';
export type ChatAgentContext = { interactionHost?:import('../interactions/contracts').RuntimeInteractionHost;signal?: AbortSignal; compositionSnapshot?: CompositionSnapshot; conversationId?: string; traceId?: string; runId?: string; priorTranscript?: AgentTranscriptMessage[]; configurationSnapshot?: AgentConfigurationSnapshot; promptSnapshot?: PromptRuntimeSnapshot; requestContext?: RequestContext; contextBlocks?: RuntimeContextBlock[]; currentContextBlocks?: RuntimeContextBlock[] };
export { validateAnswer } from '../ai/agent/citation-validation';

export type Citation = Pick<SearchHit, 'chunkId' | 'documentId' | 'documentTitle' | 'originalFilename' | 'sourceStartLine' | 'sourceEndLine'>;
export type ToolStep = { id: string; label: string; status: 'running' | 'completed'; detail?: string; durationMs?: number };
export type CommentaryEvent = { id: string; type: 'commentary'; text: string };
export type PublicProgressEvent = {
  type: 'progress';
  id: string;
  stage: 'planning' | 'preflight' | 'tool' | 'answer';
  status: 'running' | 'completed';
  text: string;
  operationId?: string;
  tool?: string;
  durationMs?: number;
  resultCount?: number;
  /** Completed activity outcome; never a Tool result body. */
  ok?: boolean;
};
export type ProcessEvent = ({ type: 'tool' } & ToolStep) | CommentaryEvent | PublicProgressEvent;
export type ChatAnswer = { uiBlocks?: import("../tool-management/ui-tool").UiBlock[]; contextUsage?: import("./context-governor").ModelContextUsage; answer: string; refused: boolean; citations: Citation[]; artifacts?:AgentArtifact[];references?:AgentReference[];structured?:JsonValue;toolSteps?: ToolStep[]; progressEvents?: ProcessEvent[]; context?: ContextEstimate };
export type ChatStreamCallbacks = {
  onContextUsage?: (context: import("./context-governor").ModelContextUsage) => void;
  /** Server-owned continuation bridge; never accepted from public JSON. */
  interactionHost?: import('../interactions/contracts').RuntimeInteractionHost;
  executionTraceId?: string;
  integrationCallId?: string;
  /** Trusted transport cancellation, never read from request JSON. */
  signal?: AbortSignal;
  onToolUi?: (block: import("../tool-management/ui-tool").UiBlock) => void;
  onAnswerStarted?: (metadata: { citations: Citation[] }) => void;
  onAnswerDelta?: (text: string) => void;
  /** Replace provisional body; done remains authoritative. */
  onAnswerReset?: (text: string) => void;
  onProgress?: (event: PublicProgressEvent) => void;
  onCommentary?: (event: CommentaryEvent) => void;
  onCommentaryDelta?: (event: CommentaryEvent) => void;
  onRetryStatus?: (event: RetryStatusEvent) => void;
};
export type ChatRun = {
  fileOutputs?: readonly import('../artifacts/file-output').PendingFileOutput[];
  traceId?: string;
  result: ChatAnswer;
  contextSnapshot: Record<string, unknown>;
  rawModelOutput: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export function retrievalQuery(question: string, history: PreviousTurnDto[] = []): string {
  const current = question.trim();
  if (!history.length || !/(^那|^它|^这个|^这种|^该|^上面|^前面|^还有|^那么|它|这个|这种|该项|呢[？?]?$)/u.test(current)) return current;
  const previous = history.slice(-2).map((turn) => turn.question.trim()).join(' ');
  return `${previous} ${current}`.slice(-200);
}

@Injectable()
export class ChatService {
  constructor(private readonly orchestrator: ChatOrchestratorService, @Optional() private readonly llm?: LlmService) {}

  async ask(question: string, history: PreviousTurnDto[] = []): Promise<ChatAnswer> {
    return (await this.askDetailed(question, history)).result;
  }

  async askDetailed(question: string, history: PreviousTurnDto[] = [], summary = '', onContext?: (context: Record<string, unknown>) => void, onStep?: (step: ToolStep) => void, onCommentary?: (event: CommentaryEvent) => void, requestedSkillId?: string, callbacks?: ChatStreamCallbacks, agentContext?: ChatAgentContext): Promise<ChatRun> {
    const task = async () => {
      const captureContext = (context: Record<string, unknown>) => {
        const plan = this.llm?.planMetadata();
        if (plan) context.modelPlan = plan;
        onContext?.(context);
      };
      const run = await this.orchestrator.askDetailed(question, history, summary, captureContext, onStep, onCommentary, requestedSkillId, callbacks, agentContext);
      if (this.llm?.planMetadata()) run.contextSnapshot.modelPlan = this.llm.planMetadata();
      return run;
    };
    return this.llm ? this.llm.withModelPlan(task) : task();
  }

}
