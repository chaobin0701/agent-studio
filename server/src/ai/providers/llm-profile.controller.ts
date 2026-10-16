import { ConflictException } from '@nestjs/common';
import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { PermissionGuard } from '../../admin/permission.guard';
import { RequirePermission } from '../../admin/permission.decorator';
import type { AdminRequest } from '../../admin/admin.types';
import { LlmProfileService } from './llm-profile.service';

@Controller('admin/model-profiles/llm')
@UseGuards(AdminAuthGuard, PermissionGuard)
export class LlmProfileController {
  constructor(private readonly profiles: LlmProfileService) {}

  @Get()
  @RequirePermission('model_profiles.read', 'model_profiles.manage')
  list() { return this.profiles.list(); }

  @Post()
  @RequirePermission('model_profiles.manage')
  create(@Req() request: AdminRequest, @Body() body: unknown) { throw new ConflictException('请使用模型管理的账户、部署与方案版本入口'); }

  @Post('test')
  @RequirePermission('model_profiles.manage')
  testConnection(@Body() body: unknown) { return this.profiles.testConnection(body); }

  @Patch(':id')
  @RequirePermission('model_profiles.manage')
  update(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) { throw new ConflictException('请使用模型管理的账户、部署与方案版本入口'); }

  @Delete(':id')
  @RequirePermission('model_profiles.manage')
  remove(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    throw new ConflictException('请使用模型管理的账户、部署与方案版本入口');
  }

  @Post(':id/activate')
  @RequirePermission('model_profiles.manage')
  activate(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number) { throw new ConflictException('请使用模型管理的账户、部署与方案版本入口'); }

  @Patch(':id/status')
  @RequirePermission('model_profiles.manage')
  status(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number, @Body() body: { enabled?: unknown }) {
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('enabled must be a boolean');
    throw new ConflictException('请使用模型管理的账户、部署与方案版本入口');
  }

  @Post(':id/test')
  @RequirePermission('model_profiles.manage')
  test(@Param('id', ParseIntPipe) id: number) { return this.profiles.test(id); }
}
