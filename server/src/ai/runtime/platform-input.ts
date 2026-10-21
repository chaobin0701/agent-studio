import type { PreviousTurnDto } from "../../chat/chat.dto";
import type { EventSink } from "../../channels/event-sink";
import type { SkillDefinition, SkillSummary } from "../skills/skill.types";
import type { SearchHit } from "../../documents/fuse-search-results";
import type {
  CommentaryEvent,
  PublicProgressEvent,
} from "../../chat/chat.service";
import type { RetryStatusEvent } from "../../chat/llm.service";
import type { AgentConfigurationSnapshot } from "../../config/agent-config";
import type { AgentTranscriptMessage } from "../../chat/agent-transcript";
import type { RequestContext } from "../../chat/request-context";
import type {
  RestoredContext,
  RuntimeContextBlock,
} from "../context/context-contribution";
import type { PromptRuntimeSnapshot } from "../../prompts/prompt-runtime.service";

export type PlatformAgentInput = {
  /** Authenticated host bridge, never caller-provided JSON. */
  interactionHost?: import("../../interactions/contracts").RuntimeInteractionHost;
  /** Server-validated generic input, not a second executor or a Chat envelope. */
  taskInput?: import("../agent/execution-contract").AgentTaskInput;
  signal?: AbortSignal;
  requestContext?: RequestContext;
  restoredContext?: RestoredContext;
  /** Trusted host extension point; never populated directly from a visitor request body. */
  initialContextBlocks?: RuntimeContextBlock[];
  /** Trusted freshness callback; never populated from HTTP JSON. */
  validateContextResource?: (
    resource: import("../context/context-contribution").ContextResource,
    signal: AbortSignal,
  ) => Promise<void>;
  configurationSnapshot?: AgentConfigurationSnapshot;
  promptSnapshot?: PromptRuntimeSnapshot;
  question: string;
  summary: string;
  recentHistory: PreviousTurnDto[];
  availableSkills?: SkillSummary[];
  initialSkills?: SkillDefinition[];
  initialEvidence?: SearchHit[];
  preflight?: {
    query: string | null;
    durationMs: number;
    hitCount: number;
    retrievalMode?: string;
    errorCode?: string;
  };
  conversationId?: string;
  traceId?: string;
  runId?: string;
  priorTranscript?: AgentTranscriptMessage[];
};

export type PlatformAgentCallbacks = {
  onContextUsage?: (context: import("../../chat/context-governor").ModelContextUsage) => void;
  /** Provisional public answer from the current model stream. */
  onAnswerDelta?: (text: string) => void;
  onAnswerReset?: (text: string) => void;
  onContext?: (context: Record<string, unknown>) => void;
  eventSink?: EventSink;
  onProgress?: (event: PublicProgressEvent) => void;
  onCommentary?: (event: CommentaryEvent) => void;
  onCommentaryDelta?: (event: CommentaryEvent) => void;
  onRetryStatus?: (event: RetryStatusEvent) => void;
};
