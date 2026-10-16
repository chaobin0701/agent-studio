export type ChannelName = 'browser' | 'api';
import type { RequestContext } from '../chat/request-context';

export type InboundMessage = {
  channel: ChannelName;
  conversationId: string;
  ownerId: string;
  question: string;
  context?: RequestContext;
  clientRequestId?: string;
  requestId: string;
  /** Optional controlled override; the server only accepts registered skills. */
  skillId?: string;
};
