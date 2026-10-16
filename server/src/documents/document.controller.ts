import { BadRequestException, Body, Controller, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRequest } from '../admin/admin.types';
import { RequirePermission } from '../admin/permission.decorator';
import { PermissionGuard } from '../admin/permission.guard';
import { SecurityRateLimitService } from '../security/security-rate-limit.service';
import { UploadDocumentDto } from './document.dto';
import { DocumentService } from './document.service';
import { DOCUMENT_UPLOAD_OPTIONS } from './document-upload.options';

@Controller('admin/documents')
@UseGuards(AdminAuthGuard, PermissionGuard)
export class DocumentController {
  constructor(private readonly documents: DocumentService, private readonly rateLimit: SecurityRateLimitService) {}

  @Post()
  @HttpCode(202)
  @RequirePermission('documents.upload')
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  upload(@Req() request: AdminRequest, @UploadedFile() file: Express.Multer.File, @Body() body: UploadDocumentDto) {
    const source = request as AdminRequest & { ip?: string; socket?: { remoteAddress?: string } };
    return this.rateLimit.run('document-upload', source.ip || source.socket?.remoteAddress || `admin:${request.admin!.id}`, () => this.documents.upload(request.admin!.id, file, body.title, undefined, body.processingConfig, body.deferProcessing === 'true'));
  }

  @Get()
  @RequirePermission('documents.read')
  list(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.documents.list(Math.max(1, Math.min(limit, 100)), Math.max(0, offset));
  }

  @Get(':id')
  @RequirePermission('documents.read')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.documents.get(id);
  }

  @Get(':id/chunks')
  @RequirePermission('documents.read')
  listChunks(@Param('id', ParseIntPipe) id: number) {
    return this.documents.listChunks(id);
  }

  @Patch(':id/archive')
  @RequirePermission('documents.archive')
  archive(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number) {
    return this.documents.archive(request.admin!.id, id);
  }

  @Patch(':id/unarchive')
  @RequirePermission('documents.archive')
  unarchive(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number) {
    return this.documents.unarchive(request.admin!.id, id);
  }

  @Patch(':id/retrieval-status')
  @RequirePermission('documents.archive')
  setEnabled(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number, @Body() body: { enabled?: unknown }) {
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('enabled must be boolean');
    return this.documents.setEnabled(request.admin!.id, id, body.enabled);
  }

  @Post(':id/retry')
  @RequirePermission('documents.reprocess')
  retry(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number) {
    return this.documents.retry(request.admin!.id, id);
  }

  @Post(':id/reprocess')
  @RequirePermission('documents.reprocess')
  reprocess(@Req() request: AdminRequest, @Param('id', ParseIntPipe) id: number) {
    return this.documents.reprocess(request.admin!.id, id);
  }
}
