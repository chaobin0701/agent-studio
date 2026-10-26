import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { PermissionGuard } from '../admin/permission.guard';
import { RequirePermission } from '../admin/permission.decorator';
import type { AdminRequest } from '../admin/admin.types';
import { IntegrationAppDto, IntegrationKeyDto, WidgetSessionDto } from './integration.dto';
import { IntegrationService } from './integration.service';
import { NoStoreInterceptor } from './no-store.interceptor';

@Controller('admin/integrations')
@UseGuards(AdminAuthGuard, PermissionGuard)
@UseInterceptors(NoStoreInterceptor)
export class AdminIntegrationController {
  constructor(private readonly access: IntegrationService) {}
  @Get() @RequirePermission('integrations.read', 'integrations.manage')
  list() { return this.access.list(); }
  @Get('agent-options') @RequirePermission('integrations.read','integrations.manage')
  agentOptions() {return this.access.agentOptions();}
  @Get(':id/conversations/:conversationId/configurations') @RequirePermission('conversations.debug')
  configurations(@Param('id', ParseUUIDPipe) id: string, @Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.access.conversationConfigurations(id, conversationId);
  }
  @Get(':id') @RequirePermission('integrations.read', 'integrations.manage')
  detail(@Param('id', ParseUUIDPipe) id: string) { return this.access.detail(id); }
  @Post() @RequirePermission('integrations.manage')
  create(@Req() request: AdminRequest, @Body() body: IntegrationAppDto) { return this.access.save(request.admin!.id, body); }
  @Patch(':id') @RequirePermission('integrations.manage')
  update(@Req() request: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: IntegrationAppDto) { return this.access.save(request.admin!.id, body, id); }
  @Post(':id/keys') @RequirePermission('integrations.manage')
  key(@Req() request: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: IntegrationKeyDto) { return this.access.createKey(request.admin!.id, id, body); }
  @Post(':id/keys/:keyId/rotate') @RequirePermission('integrations.manage')
  rotate(@Req() request: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('keyId', ParseUUIDPipe) keyId: string, @Body() body: IntegrationKeyDto) { return this.access.createKey(request.admin!.id, id, body, keyId); }
  @Post(':id/keys/:keyId/revoke') @RequirePermission('integrations.manage')
  revoke(@Req() request: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('keyId', ParseUUIDPipe) keyId: string) { return this.access.revokeKey(request.admin!.id, id, keyId); }
}

@Controller('widget')
export class WidgetSessionController {
  constructor(private readonly access: IntegrationService) {}
  @Post('session') @Header('Cache-Control', 'no-store')
  session(@Req() request: Request, @Body() body: WidgetSessionDto) { return this.access.widgetSession(request, body.appId, body.resumeToken); }
}
