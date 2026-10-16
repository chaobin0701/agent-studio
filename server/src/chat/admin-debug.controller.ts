import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRequest } from '../admin/admin.types';
import { PermissionGuard } from '../admin/permission.guard';
import { RequirePermission } from '../admin/permission.decorator';
import { AdminDebugService } from './admin-debug.service';
import { InspectConversationDebugDto } from './admin-debug.dto';

@Controller('admin/debug')
@UseGuards(AdminAuthGuard, PermissionGuard)
@RequirePermission('conversations.debug')
export class AdminDebugController {
  constructor(private readonly debug: AdminDebugService) {}

  @Post('inspect')
  inspect(@Req() request: AdminRequest, @Body() body: InspectConversationDebugDto) {
    return this.debug.inspect(request.admin!.id, body);
  }
}
