import {
  Controller,
  Get,
  Delete,
  Param,
  ParseUUIDPipe,
  ParseIntPipe,
  Req,
  Res,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import { AgentAccessGuard } from "../integrations/integration.guards";
import type { IntegrationRequest } from "../integrations/integration.types";
import { NoStoreInterceptor } from "../integrations/no-store.interceptor";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { PermissionGuard } from "../admin/permission.guard";
import { RequirePermission } from "../admin/permission.decorator";
import type { AdminRequest } from "../admin/admin.types";
import { ExecutionArtifactService } from "./execution-artifact.service";

export function sendArtifact(
  response: Response,
  file: Awaited<ReturnType<ExecutionArtifactService["downloadForAdmin"]>>,
) {
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${file.metadata.filename}"`,
  );
  response.setHeader("Content-Length", file.content.length);
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  return response.send(file.content);
}

@Controller("v1/agent/:agentId/artifacts")
@UseGuards(AgentAccessGuard)
@UseInterceptors(NoStoreInterceptor)
export class AgentArtifactController {
  constructor(private readonly artifacts: ExecutionArtifactService) {}
  @Get(":id") async download(
    @Req() request: IntegrationRequest,
    @Param("agentId", ParseIntPipe) agentId: number,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("userId") userId: string | undefined,
    @Res() response: Response,
  ) {
    return sendArtifact(
      response,
      await this.artifacts.downloadForApp(
        request.integration,
        agentId,
        id,
        userId,
      ),
    );
  }
}

@Controller("admin/executions/:traceId/artifacts")
@UseGuards(AdminAuthGuard, PermissionGuard)
@UseInterceptors(NoStoreInterceptor)
export class AdminArtifactController {
  constructor(private readonly artifacts: ExecutionArtifactService) {}
  @Get() @RequirePermission("conversations.read") list(
    @Param("traceId", ParseUUIDPipe) traceId: string,
  ) {
    return this.artifacts.list(traceId);
  }
  @Get(":id") @RequirePermission("conversations.read") async download(
    @Req() request: AdminRequest,
    @Param("traceId", ParseUUIDPipe) traceId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() response: Response,
  ) {
    return sendArtifact(
      response,
      await this.artifacts.downloadForAdmin(traceId, id, request.admin!.id),
    );
  }
  @Delete(":id") @RequirePermission("executions.artifacts.manage") purge(
    @Req() request: AdminRequest,
    @Param("traceId", ParseUUIDPipe) traceId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.artifacts.purge(traceId, id, request.admin!.id);
  }
}
