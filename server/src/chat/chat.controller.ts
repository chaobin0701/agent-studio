import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, HttpException, Optional, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AgentManagementService } from '../agent-management/agent-management.service';
import { ExecutionArtifactService } from '../artifacts/execution-artifact.service';
import { sendArtifact } from '../artifacts/artifact.controller';
import { AppConfigService } from '../config/config.service';
import { DEFAULT_AGENT_CONFIGURATION } from '../config/agent-config';
import type { Request, Response } from 'express';
import { AskQuestionDto } from './chat.dto';
import { ChatRateLimitService } from './chat-rate-limit.service';
import { ChatService } from './chat.service';
import { ConversationService } from './conversation.service';
import { ChatApplicationService } from './chat-application.service';
import { AgentSettingsService } from '../config/agent-settings.service';
import { LegacyWebsiteGuard } from '../integrations/integration.guards';
import { IntegrationChatGateway } from './integration-chat.gateway';
import type { IntegrationRequest } from '../integrations/integration.types';
import { IntegrationService } from '../integrations/integration.service';
import { hasRetryErrorMetadata, publicIntegrationError } from '../integrations/quota-error';
import type { RequestContext } from './request-context';

@Controller('chat')
@UseGuards(LegacyWebsiteGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly rateLimit: ChatRateLimitService,
    private readonly conversations: ConversationService,
    private readonly application: ChatApplicationService,
    @Optional() private readonly config?: AppConfigService,
    @Optional() private readonly settings?: AgentSettingsService,
    @Optional() private readonly gateway?: IntegrationChatGateway,
    @Optional() private readonly access?: IntegrationService,
    @Optional() private readonly management?: AgentManagementService,
    @Optional() private readonly artifacts?: ExecutionArtifactService,
  ) {}
  @Get('artifacts/:id') @Header('Cache-Control', 'no-store') async downloadArtifact(@Param('id',ParseUUIDPipe) id:string,@Req() request:IntegrationRequest,@Res() response:Response) {
    const ownerId=await this.conversations.session(request,response);
    return sendArtifact(response,await this.artifacts!.downloadForApp({...request.integration,ownerId},request.integration.app.agentId,id));
  }

  @Get('presentation')
  presentation() {
    if (this.management) return this.management.snapshot().then(snapshot => snapshot.agents.get(snapshot.entryVersionId)!.spec.welcome);
    // Public allowlist: welcome text only; no persona, memory or tool policies.
    return this.settings ? this.settings.snapshot().then(snapshot => snapshot.configuration.welcome) : (this.config?.agent ?? DEFAULT_AGENT_CONFIGURATION).welcome;
  }

  // Keep the existing HttpOnly visitor/session instead of creating a second widget identity.
  // Both surfaces reuse the same service, authorization and inspection rate budget.
  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(@Req() request: IntegrationRequest, @Res({ passthrough: true }) response: Response) {
    const ownerId = await this.conversations.session(request, response);
    return this.access!.publicStatus({ ...request.integration, ownerId });
  }

  @Get('usage')
  @Header('Cache-Control', 'no-store')
  async usage(@Req() request: IntegrationRequest, @Res({ passthrough: true }) response: Response) {
    const ownerId = await this.conversations.session(request, response);
    return this.access!.publicUsage({ ...request.integration, ownerId });
  }

  @Get('quota')
  @Header('Cache-Control', 'no-store')
  async quota(@Req() request: IntegrationRequest, @Res({ passthrough: true }) response: Response) {
    const ownerId = await this.conversations.session(request, response);
    return this.access!.publicWebsiteQuota({ ...request.integration, ownerId });
  }

  @Get('conversations')
  async listConversations(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.conversations.list(await this.conversations.session(request, response));
  }

  @Post('conversations')
  async createConversation(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const owner = await this.conversations.session(request, response);
    return this.rateLimit.run(request.ip || request.socket.remoteAddress || 'unknown', () => this.conversations.create(owner));
  }

  @Get('conversations/:id/messages')
  async listMessages(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.conversations.messages(await this.conversations.session(request, response), id);
  }

  @Get('conversations/:id/runs')
  async listRuns(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.conversations.runs(await this.conversations.session(request, response), id);
  }

  @Get('conversations/:id/context')
  async context(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.conversations.context(await this.conversations.session(request, response), id);
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  async deleteConversation(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.conversations.remove(await this.conversations.session(request, response), id);
  }

  @Post('conversations/:id/messages')
  @HttpCode(200)
  async askInConversation(@Param('id', ParseUUIDPipe) id: string, @Body() body: AskQuestionDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.respond(request, response, body.question, id, false, body.context);
  }

  @Post('conversations/:id/messages/stream')
  @HttpCode(200)
  async streamInConversation(@Param('id', ParseUUIDPipe) id: string, @Body() body: AskQuestionDto, @Req() request: Request, @Res() response: Response) {
    return this.respond(request, response, body.question, id, true, body.context);
  }

  @Post()
  @HttpCode(200)
  ask(@Body() body: AskQuestionDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    if (body.history?.length) throw new BadRequestException('请使用会话接口续接上下文，不再接受客户端提供的 history');
    return this.respond(request, response, body.question, undefined, false, body.context);
  }

  @Post('stream')
  @HttpCode(200)
  stream(@Body() body: AskQuestionDto, @Req() request: Request, @Res() response: Response) {
    if (body.history?.length) throw new BadRequestException('请使用会话接口续接上下文，不再接受客户端提供的 history');
    return this.respond(request, response, body.question, undefined, true, body.context);
  }

  private async respond(request: Request, response: Response, question: string, conversationId: string | undefined, stream: boolean, context?: RequestContext) {
    const owner = await this.conversations.session(request, response);
    const prepared = await this.gateway!.prepare((request as IntegrationRequest).integration, owner, conversationId, question, this.idempotencyKey(request), context);
    try {
      return await this.rateLimit.run(request.ip || request.socket.remoteAddress || 'unknown', async () => {
        if (!stream) return this.gateway!.execute(prepared, this.requestId(request));
        this.beginStream(response);
        const transport = new AbortController();
        const disconnected = () => { if (!response.writableEnded) transport.abort(new Error('Client disconnected')); };
        response.once('close', disconnected);
        this.writeEvent(response, 'run_started', { conversationId: prepared.admission.conversationId, clientRequestId: prepared.admission.clientRequestId, replayed: Boolean(prepared.admission.cached) });
        try {
          let streamed = false;
          const commentaryIds = new Set<string>();
          const startCommentary = (id: string) => {
            if (commentaryIds.has(id)) return;
            commentaryIds.add(id);
            this.writeEvent(response, 'commentary_started', { id });
          };
          const answer = await this.gateway!.execute(prepared, this.requestId(request), {
            signal: transport.signal,
            onAnswerStarted: metadata => this.writeEvent(response, 'answer_started', metadata),
            onAnswerDelta: text => { streamed = true; this.writeEvent(response, 'answer_delta', { text }); },
            onAnswerReset: text => this.writeEvent(response, 'answer_reset', { text }),
            onProgress: event => this.writeEvent(response, 'progress', event),
            onCommentaryDelta: ({ id, text }) => { startCommentary(id); this.writeEvent(response, 'commentary_delta', { id, text }); },
            onCommentary: ({ id, text }) => { startCommentary(id); this.writeEvent(response, 'commentary_completed', { id, text }); },
            onRetryStatus: event => this.writeEvent(response, 'retry_status', event),
          });
          await this.writeAnswerStream(response, answer, streamed);
        } catch (error) { this.writeStreamError(response, error); }
        finally { response.off('close', disconnected); }
      });
    } catch (error) {
      if (prepared.admission.callId) await this.access!.finish(prepared.admission.callId, null);
      throw error;
    }
  }

  private beginStream(response: Response) {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
  }

  private writeStreamError(response: Response, error?: unknown) {
    if (!response.destroyed) {
      const status = error instanceof HttpException ? error.getStatus() : 503;
      response.statusCode = status;
      const message = status === 409 ? '上一轮请求仍在处理中，请稍后查看会话。' : status === 400 ? '请求参数无效，请重新发送。' : '回答服务暂时不可用，请稍后重试。';
      response.write(`event: error\ndata: ${JSON.stringify(status === 429 || status === 502 || status === 503 || hasRetryErrorMetadata(error) ? publicIntegrationError(error) : { status, message })}\n\n`);
      response.end();
    }
  }

  private idempotencyKey(request: Request): string | undefined {
    const value = request.headers['idempotency-key'];
    return Array.isArray(value) ? value[0] : value;
  }

  private requestId(request: Request): string {
    const value = request.headers['x-request-id'];
    return (Array.isArray(value) ? value[0] : value) ?? `${request.method}:${request.originalUrl}`;
  }

  private async writeAnswerStream(response: Response, answer: { answer: string; refused: boolean; citations: unknown[] }, streamed = false) {
    if (!streamed && !answer.refused) {
      this.writeEvent(response, 'answer_delta', { text: answer.answer });
    }
    if (streamed) this.writeEvent(response, 'answer_completed', { citations: answer.citations });
    if (!response.destroyed) {
      this.writeEvent(response, 'done', answer);
      response.end();
    }
  }

  private writeEvent(response: Response, event: string, data: unknown) {
    if (response.destroyed || response.writableEnded) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

}
