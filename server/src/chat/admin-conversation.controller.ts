import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { RequirePermission } from '../admin/permission.decorator';
import { PermissionGuard } from '../admin/permission.guard';
import { AdminConversationService } from './admin-conversation.service';

@Controller('admin/conversations')
@UseGuards(AdminAuthGuard, PermissionGuard)
@RequirePermission('conversations.read')
export class AdminConversationController {
  constructor(private readonly conversations: AdminConversationService) {}

  @Get()
  list(
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('q') query = '',
    @Query('status') status = 'all',
    @Query('visitorId') visitorId = '',
    @Query('device') device = 'all',
    @Query('since') since = '',
    @Query('applicationId') applicationId = '',
  ) {
    return this.conversations.list(limit, offset, query, status, visitorId, device, since || null, applicationId);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.detail(id);
  }
}
