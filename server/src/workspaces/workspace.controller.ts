import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { PermissionGuard } from '../admin/permission.guard';
import { RequirePermission } from '../admin/permission.decorator';
import type { AdminRequest } from '../admin/admin.types';
import { WorkspaceService } from './workspace.service';

@Controller('admin/workspaces')
@UseGuards(AdminAuthGuard)
export class WorkspaceController {
  constructor(private readonly service:WorkspaceService) {}
  @Get() list(@Req() r:AdminRequest) {return this.service.list(r.admin!.id);}
  @Get(':id/access') access(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number) {return this.service.access(r.admin!.id,id);}
  @Get(':id/settings') settings(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number) {return this.service.settings(r.admin!.id,id);}
  @Patch(':id/settings') saveSettings(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {return this.service.saveSettings(r.admin!.id,id,body);}
  @Get(':id/copy-options') copyOptions(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number) {return this.service.copyOptions(r.admin!.id,id);}
  @Post(':id/copy') copy(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {return this.service.copy(r.admin!.id,id,body);}
  @Post() @UseGuards(PermissionGuard) @RequirePermission('workspaces.manage') create(@Req() r:AdminRequest,@Body() body:unknown) {return this.service.create(r.admin!.id,body);}
  @Patch(':id') updateInfo(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {return this.service.updateInfo(r.admin!.id,id,body);}
  @Get(':id/members') members(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number) {return this.service.members(r.admin!.id,id);}
  @Get(':id/member-options') memberOptions(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number) {return this.service.memberOptions(r.admin!.id,id);}
  @Post(':id/members') member(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {return this.service.setMember(r.admin!.id,id,body);}
  @Delete(':id/members/:memberId') remove(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Param('memberId',ParseIntPipe) memberId:number) {return this.service.removeMember(r.admin!.id,id,memberId);}
  @Patch(':id/status') status(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() body:{enabled:boolean}) {return this.service.status(r.admin!.id,id,body.enabled);}
}
