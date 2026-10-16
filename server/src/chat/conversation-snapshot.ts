import { PreviousTurnDto } from './chat.dto';
import type { AgentTranscriptMessage } from './agent-transcript';
import type { RuntimeContextBlock } from '../ai/context/context-contribution';

export type SnapshotMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  refused: boolean | null;
};

/** The only memory boundary exposed to the Agent is one conversation. */
export interface ConversationSnapshot {
  conversationId: string;
  summary: string;
  summaryThroughMessageId: number | null;
  recentMessages: SnapshotMessage[];
  history: PreviousTurnDto[];
  agentTranscript: AgentTranscriptMessage[];

  contextBlocks?: RuntimeContextBlock[];
}
