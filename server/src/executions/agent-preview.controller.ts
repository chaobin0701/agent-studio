import {
  Body,
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { PermissionGuard } from "../admin/permission.guard";
import { RequirePermission } from "../admin/permission.decorator";
import type { AdminRequest } from "../admin/admin.types";
import { NoStoreInterceptor } from "../integrations/no-store.interceptor";
import { SecurityRateLimitService } from "../security/security-rate-limit.service";
import { AgentRunService } from "./agent-run.service";
import { AgentPreviewService } from "./agent-preview.service";
import { runResponse } from "./run-response";

function draftSelection(version?: string, revision?: string) {
  if (version === undefined && revision === undefined) return undefined;
  if (
    !version ||
    !revision ||
    !/^\d+$/u.test(version) ||
    !/^\d+$/u.test(revision)
  )
    throw new BadRequestException("草稿预览需要版本和修订号");
  const parsed = { versionId: Number(version), revision: Number(revision) };
  if (!Object.values(parsed).every((v) => Number.isSafeInteger(v) && v > 0))
    throw new BadRequestException("草稿标识无效");
  return parsed;
}

@Controller("admin/agent-preview")
@UseGuards(AdminAuthGuard, PermissionGuard)
@RequirePermission("agent_config.manage")
@UseInterceptors(NoStoreInterceptor)
export class AgentPreviewController {
  constructor(
    private readonly preview: AgentPreviewService,
    private readonly runs: AgentRunService,
    private readonly limiter: SecurityRateLimitService,
  ) {}
  @Get("options") options(
    @Req() r: AdminRequest,
    @Query("applicationId") applicationId?: string,
  ) {
    return this.preview.options(r.admin!.id, applicationId);
  }
  @Get("agents/:id/options") agentOptions(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Query("applicationId") applicationId?: string,
    @Query("draftVersionId") draftVersionId?: string,
    @Query("draftRevision") draftRevision?: string,
  ) {
    return this.preview.options(
      r.admin!.id,
      applicationId,
      id,
      draftSelection(draftVersionId, draftRevision),
    );
  }
  @Post("runs")
  @HttpCode(200)
  async execute(
    @Req() r: AdminRequest,
    @Body() input: unknown,
    @Res() response: Response,
  ) {
    const transport = new AbortController();
    const disconnect = () => {
      if (!response.writableEnded) transport.abort();
    };
    response.once("close", disconnect);
    try {
      return await this.limiter.runConcurrent("chat", async () => {
        const prepared = await this.preview.prepare(r.admin!.id, input);
        try {
          return await runResponse(this.runs, prepared, response, transport);
        } catch (error) {
          await this.runs.cancelAdmission(prepared);
          throw error;
        }
      });
    } finally {
      response.off("close", disconnect);
    }
  }
}
