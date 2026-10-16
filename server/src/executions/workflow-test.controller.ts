import {
  Body,
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
import { WorkflowTestService } from "./workflow-test.service";

@Controller("admin/agent-resources/versions/:id")
@UseGuards(AdminAuthGuard, PermissionGuard)
@RequirePermission("agent_config.manage")
@UseInterceptors(NoStoreInterceptor)
export class WorkflowTestController {
  constructor(
    private readonly tests: WorkflowTestService,
    private readonly limiter: SecurityRateLimitService,
  ) {}
  @Get("workflow-test-options")
  options(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Query("applicationId") applicationId?: string,
  ) {
    return this.tests.options(r.admin!.id, id, applicationId);
  }
  @Post("workflow-test")
  @HttpCode(200)
  async execute(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() value: unknown,
    @Res() response: Response,
  ) {
    const transport = new AbortController();
    const disconnect = () => {
      if (!response.writableEnded) transport.abort();
    };
    response.once("close", disconnect);
    try {
      return await this.limiter.runConcurrent("chat", async () =>
        response.json(
          await this.tests.execute(r.admin!.id, id, value, transport.signal),
        ),
      );
    } finally {
      response.off("close", disconnect);
    }
  }
}
