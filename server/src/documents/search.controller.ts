import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { RequirePermission } from '../admin/permission.decorator';
import { PermissionGuard } from '../admin/permission.guard';
import { SearchService } from './search.service';

@Controller('admin/search')
@UseGuards(AdminAuthGuard, PermissionGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermission('documents.read')
  diagnose(
    @Query('q') query: unknown,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number,
    @Query('minScore') minScore: unknown,
  ) {
    return this.search.diagnose(query, Math.max(1, Math.min(limit, 20)), minScore);
  }
}
