import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { AgentMessageDto } from '../integrations/integration.dto';
import { AgentAccessGuard } from '../integrations/integration.guards';
import { IntegrationService } from '../integrations/integration.service';
import type { IntegrationRequest } from '../integrations/integration.types';
import { ConversationService } from './conversation.service';
import { IntegrationChatGateway,type PreparedChat } from './integration-chat.gateway';
import { ChatRateLimitService } from './chat-rate-limit.service';
import { NoStoreInterceptor } from '../integrations/no-store.interceptor';
import { publicIntegrationError } from '../integrations/quota-error';
import { InteractionWaiting } from '../interactions/contracts';

@Controller('v1/agent')
@UseGuards(AgentAccessGuard)
@UseInterceptors(NoStoreInterceptor)
export class AgentApiController {
  constructor(private readonly access: IntegrationService, private readonly conversations: ConversationService, private readonly gateway: IntegrationChatGateway, private readonly rateLimit: ChatRateLimitService) {}

  @Post(':agentId/messages') @HttpCode(200)
  messagesForAgent(@Param('agentId',ParseIntPipe) agentId:number,@Req() request:IntegrationRequest,@Body() body:AgentMessageDto,@Res() response:Response) {
    if(agentId!==request.integration.app.agentId)throw new ForbiddenException('此接入应用没有调用该 Agent 的权限');
    return this.messages(request,body,response);
  }

  @Post('messages') @HttpCode(200)
  async messages(@Req() request: IntegrationRequest, @Body() body: AgentMessageDto, @Res() response: Response) {
    const identity = request.integration;
    this.access.assertScope(identity, 'chat:write');
    const owner = await this.access.platformOwner(identity, body.userId);
    // Validate ownership, quota and idempotency before committing SSE headers (proper 401/403/404/429).
    const prepared = await this.gateway.prepare(identity, owner, body.conversationId, body.message, request.get('Idempotency-Key'), body.context);
    return this.executePrepared(request,response,prepared,Boolean(body.stream));
  }

  @Post('conversations/:conversationId/interactions/:interactionId/respond') @HttpCode(200)
  async respondInteraction(@Req() request:IntegrationRequest,@Param('conversationId',ParseUUIDPipe) conversationId:string,@Param('interactionId',ParseUUIDPipe) interactionId:string,@Body() value:unknown,@Res() response:Response,@Query('userId') userId?:string,@Query('stream') stream?:string) {
    this.access.assertScope(request.integration,'chat:write');
    const owner=await this.access.platformOwner(request.integration,userId);
    const task=async()=>{
      const resumed=await this.gateway.prepareResume(request.integration,owner,conversationId,interactionId,value);
      if(!resumed.prepared)return response.status(202).json({runId:resumed.runId,conversationId,replayed:true,interaction:resumed.interaction});
      return this.executePrepared(request,response,resumed.prepared,stream!=="false",true);
    };
    return request.integration.kind==='website' ? this.rateLimit.run(request.ip||'unknown',task) : this.rateLimit.runPlatform(task);
  }

  @Post('conversations/:conversationId/interactions/:interactionId/cancel') @HttpCode(200)
  async cancelInteraction(@Req() request:IntegrationRequest,@Param('conversationId',ParseUUIDPipe) conversationId:string,@Param('interactionId',ParseUUIDPipe) interactionId:string,@Query('userId') userId?:string) {
    this.access.assertScope(request.integration,'chat:write');
    return this.gateway.cancelInteraction(request.integration,await this.access.platformOwner(request.integration,userId),conversationId,interactionId);
  }

  private async executePrepared(request:IntegrationRequest,response:Response,prepared:PreparedChat,stream:boolean,executionSlotAcquired=false) {
    const identity=request.integration;
    const task = async () => {
      if (!stream) {
        try{return response.json(this.gateway.publicResult(await this.gateway.execute(prepared,this.requestId(request))));}
        catch(error){if(error instanceof InteractionWaiting)return response.status(202).json({runId:error.interaction.runId,conversationId:prepared.admission.conversationId,status:'waiting',interaction:error.interaction});throw error;}
      }
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
      const send = (event: string, data: unknown) => { if (!response.destroyed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      send('run_started', { conversationId: prepared.admission.conversationId, clientRequestId: prepared.admission.clientRequestId, replayed: Boolean(prepared.admission.cached) });
      const commentaryIds = new Set<string>();
      const transport = new AbortController();
      const disconnected = () => { if (!response.writableEnded) transport.abort(new Error('Client disconnected')); };
      response.once('close', disconnected);
      const startCommentary = (id: string) => {
        if (commentaryIds.has(id)) return;
        commentaryIds.add(id);
        send('commentary_started', { id });
      };
      try {
        const result = await this.gateway.execute(prepared, this.requestId(request), {
          signal: transport.signal,
          onAnswerStarted: metadata => send('answer_started', metadata),
          onAnswerDelta: text => send('answer_delta', { text }),
          onAnswerReset: text => send('answer_reset', { text }),
          onProgress: event => send('progress', event),
          onCommentaryDelta: ({ id, text }) => { startCommentary(id); send('commentary_delta', { id, text }); },
          onCommentary: ({ id, text }) => { startCommentary(id); send('commentary_completed', { id, text }); },
          onRetryStatus: event => send('retry_status', event),
        });
        send('answer_completed', { citations: result.citations });
        send('done', this.gateway.publicResult(result));
      } catch (error) {
        if(error instanceof InteractionWaiting)send('interaction_required',{runId:error.interaction.runId,interaction:error.interaction});
        else send('error', publicIntegrationError(error));
      } finally { response.off('close', disconnected); if (!response.writableEnded) response.end(); }
    };
    try {
      // Anonymous visitors have an additional per-IP limit. Platform quotas belong to the app, not a shared egress IP.
      return executionSlotAcquired ? await task() : identity.kind === 'website' ? await this.rateLimit.run(request.ip || 'unknown', task) : await this.rateLimit.runPlatform(task);
    } catch (error) {
      if (prepared.admission.callId) {
        if(this.gateway.cancelAdmission)await this.gateway.cancelAdmission(prepared);
        else await this.access.finish(prepared.admission.callId, null);
      }
      throw error;
    }
  }

  @Get('status')
  status(@Req() request: IntegrationRequest) {
    return this.access.publicStatus(request.integration);
  }

  @Get('chat-status')
  chatStatus(@Req() request: IntegrationRequest) {
    return this.access.displayQuota(request.integration);
  }

  @Get('usage')
  usage(@Req() request: IntegrationRequest) {
    return this.access.publicUsage(request.integration);
  }

  @Get('conversations')
  async list(@Req() request: IntegrationRequest, @Query('userId') userId?: string) {
    this.access.assertScope(request.integration, 'conversations:read');
    return this.conversations.list(await this.access.platformOwner(request.integration, userId));
  }
  @Get('conversations/:id/messages')
  async history(@Req() request: IntegrationRequest, @Param('id', ParseUUIDPipe) id: string, @Query('userId') userId?: string) {
    this.access.assertScope(request.integration, 'conversations:read');
    const messages = await this.conversations.messages(await this.access.platformOwner(request.integration, userId), id);
    return messages.map(({ id: messageId, role, content, refused, citations, structured, artifacts, uiBlocks, progressEvents, context, createdAt, contextUsage, interactions }) => ({
      id: messageId,
      role,
      content,
      refused,
      citations,
      ...(structured !== undefined && structured !== null ? { structured } : {}),
      artifacts,
      uiBlocks,
      progressEvents,
      context,
      createdAt,
      ...(role === "assistant" ? { status: "completed" as const } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(interactions ? { interactions } : {}),
    }));
  }
  @Get('conversations/:id/configurations')
  async configurations(@Req() request: IntegrationRequest, @Param('id', ParseUUIDPipe) id: string, @Query('userId') userId?: string) {
    this.access.assertScope(request.integration, 'conversations:read');
    const owner = await this.access.platformOwner(request.integration, userId);
    return this.access.conversationConfigurations(request.integration.app.id, id, owner);
  }
  @Get('conversations/:id/runs')
  async runs(@Req() request: IntegrationRequest, @Param('id', ParseUUIDPipe) id: string, @Query('userId') userId?: string) {
    this.access.assertScope(request.integration, 'conversations:read');
    return this.conversations.runs(await this.access.platformOwner(request.integration, userId), id);
  }
  @Delete('conversations/:id') @HttpCode(204)
  async remove(@Req() request: IntegrationRequest, @Param('id', ParseUUIDPipe) id: string, @Query('userId') userId?: string) {
    this.access.assertScope(request.integration, 'conversations:delete');
    await this.conversations.remove(await this.access.platformOwner(request.integration, userId), id);
  }
  private requestId(request: IntegrationRequest) { return request.get('x-request-id') ?? 'external-agent'; }
}
