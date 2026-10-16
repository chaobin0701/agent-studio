import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { DocumentController } from './document.controller';
import { DocumentQueueService } from './document-queue.service';
import { DocumentService } from './document.service';
import { EmbeddingService } from './embedding.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { KnowledgeBaseController } from './knowledge-base.controller';
import { KnowledgeBaseService } from './knowledge-base.service';
import { KnowledgeIndexService } from './knowledge-index.service';
import { EmbeddingProfileService } from './embedding-profile.service';
import { VersionSearchService } from './version-search.service';
import { EmbeddingProfileController } from './embedding-profile.controller';

@Module({
  imports: [AdminModule],
  controllers: [DocumentController, SearchController, KnowledgeBaseController, EmbeddingProfileController],
  providers: [DocumentQueueService, DocumentService, EmbeddingService, SearchService, KnowledgeBaseService, KnowledgeIndexService, EmbeddingProfileService, VersionSearchService],
  exports: [SearchService],
})
export class DocumentModule {}
