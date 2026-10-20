import {
  Body,
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import { AgentAccessGuard } from "../integrations/integration.guards";
import type { IntegrationRequest } from "../integrations/integration.types";
import { NoStoreInterceptor } from "../integrations/no-store.interceptor";
import { SecurityRateLimitService } from "../security/security-rate-limit.service";
import { runResponse } from "./run-response";
import { AgentRunService } from "./agent-run.service";
import { parseRunRequest } from "./run-request";

@Controller("v1/agent/:agentId/runs")
@UseGuards(AgentAccessGuard)
@UseInterceptors(NoStoreInterceptor)
export class AgentRunController {
  constructor(
    private readonly runs: AgentRunService,
    private readonly limiter: SecurityRateLimitService,
  ) {}

  @Post()
  @HttpCode(200)
  async create(
    @Param("agentId", ParseIntPipe) agentId: number,
    @Req() request: IntegrationRequest,
    @Body() value: unknown,
    @Res() response: Response,
  ) {
    const input = parseRunRequest(value);
    const prepared = await this.runs.prepare(
      request.integration,
      agentId,
      input,
      request.get("Idempotency-Key"),
    );
    const transport = new AbortController();
    const disconnected = () => {
      if (!response.writableEnded)
        transport.abort(new Error("Client disconnected"));
    };
    response.once("close", disconnected);
    try {
      return await this.limiter.runConcurrent("chat", async () => {
        return runResponse(this.runs, prepared, response, transport);
      });
    } catch (error) {
      await this.runs.cancelAdmission(prepared);
      throw error;
    } finally {
      response.off("close", disconnected);
    }
  }

  @Get(":runId")
  get(
    @Param("agentId", ParseIntPipe) agentId: number,
    @Param("runId", ParseUUIDPipe) runId: string,
    @Req() request: IntegrationRequest,
    @Query("userId") userId?: string,
  ) {
    return this.runs.get(request.integration, agentId, runId, userId);
  }
  @Post(":runId/interactions/:interactionId/respond")
  @HttpCode(200)
  async respond(
    @Param("agentId",ParseIntPipe) agentId:number,
    @Param("runId",ParseUUIDPipe) runId:string,
    @Param("interactionId",ParseUUIDPipe) interactionId:string,
    @Req() request:IntegrationRequest,
    @Query("userId") userId:string|undefined,
    @Body() value:unknown,
    @Res() response:Response,
  ) {
    if(!value||typeof value!=="object"||!("interactionId" in value)||value.interactionId!==interactionId) throw new BadRequestException("交互标识与路径不一致");
    // Acquire the process slot before claiming the reply. A temporary 429 must
    // leave the card pending, with its checkpoint available for a later reply.
    return this.limiter.runConcurrent("chat",async()=>{
      const resumed=await this.runs.prepareResume(request.integration,agentId,runId,value,userId);
      if(!resumed.prepared) return response.status(202).json({runId,replayed:true,interaction:resumed.interaction});
      const transport=new AbortController();
      const disconnect=()=>{if(!response.writableEnded)transport.abort(new Error("Client disconnected"));};
      response.once("close",disconnect);
      try { return await runResponse(this.runs,resumed.prepared,response,transport); }
      catch(error) { await this.runs.cancelAdmission(resumed.prepared);throw error; }
      finally {response.off("close",disconnect);}
    });
  }
}
