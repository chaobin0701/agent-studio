import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { PermissionGuard } from "../admin/permission.guard";
import { RequirePermission } from "../admin/permission.decorator";
import type { AdminRequest } from "../admin/admin.types";
import { ToolManagementService } from "./tool-management.service";
import { resourceState } from "../agent-management/resource-lifecycle";

@Controller("admin/external-tools")
@UseGuards(AdminAuthGuard, PermissionGuard)
export class ToolManagementController {
  constructor(private readonly service: ToolManagementService) {}
  @Get("credentials")
  @RequirePermission("agent_config.read", "agent_config.manage")
  credentials() {
    return this.service.credentials();
  }
  @Post("credentials")
  @RequirePermission("agent_config.manage")
  createCredential(@Req() r: AdminRequest, @Body() body: unknown) {
    return this.service.createCredential(r.admin!.id, body);
  }
  @Patch("credentials/:id")
  @RequirePermission("agent_config.manage")
  updateCredential(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    return this.service.updateCredential(r.admin!.id, id, body);
  }
  @Get("mcp")
  @RequirePermission("agent_config.read", "agent_config.manage")
  servers(@Query('state') state?:string) {
    return this.service.servers(resourceState(state));
  }
  @Get("mcp/:id")
  @RequirePermission("agent_config.read", "agent_config.manage")
  server(@Param("id", ParseIntPipe) id: number) {
    return this.service.server(id);
  }
  @Get('mcp/:id/references') @RequirePermission('agent_config.read','agent_config.manage') references(@Param('id',ParseIntPipe) id:number){return this.service.references(id);}
  @Post('mcp/:id/archive') @RequirePermission('agent_config.manage') archive(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number){return this.service.lifecycle(r.admin!.id,id,'archive');}
  @Delete('mcp/:id') @RequirePermission('agent_config.manage') remove(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number){return this.service.lifecycle(r.admin!.id,id,'delete');}
  @Post('mcp/:id/restore') @RequirePermission('agent_config.manage') restore(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number){return this.service.lifecycle(r.admin!.id,id,'restore');}
  @Post("mcp") @RequirePermission("agent_config.manage") createServer(
    @Req() r: AdminRequest,
    @Body() body: unknown,
  ) {
    return this.service.createServer(r.admin!.id, body);
  }
  @Post("mcp/:id/versions") @RequirePermission("agent_config.manage") configure(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    return this.service.configureServer(r.admin!.id, id, body);
  }
  @Patch("mcp/:id/status") @RequirePermission("agent_config.manage") status(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { enabled?: boolean },
  ) {
    if (typeof body?.enabled !== "boolean")
      throw new BadRequestException("需要 enabled");
    return this.service.serverStatus(r.admin!.id, id, body.enabled);
  }
  @Post("mcp/:id/test") @RequirePermission("agent_tools.execute") test(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    return this.service.probe(r.admin!.id, id, body);
  }
  @Post("mcp/:id/discover") @RequirePermission("agent_tools.execute") discover(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    if (!r.workspacePermissionCodes?.includes("agent_config.manage"))
      throw new ForbiddenException("获取并更新目录需要配置管理权限");
    return this.service.probe(r.admin!.id, id, body, true);
  }
  @Post("mcp/:id/tools") @RequirePermission("agent_config.manage") importTool(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    return this.service.importTool(r.admin!.id, id, body);
  }
}
